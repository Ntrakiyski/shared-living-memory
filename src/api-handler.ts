// ─── OAuth API handler — /mcp only ──────────────────────────────────────────
// Purpose: Handles MCP protocol requests under the OAuthProvider, resolving
//          per-user identity and delegating to the MCP server.
// Input:   Request, Env, ExecutionContext from Cloudflare Workers runtime.
// Output:  Response — either the raw MCP response or a sanitized tools-list.
// Logic:   1. Await schema initialization before authentication or tool setup.
//          2. Resolve a verified actor from per-user credentials or OAuth props.
//          3. Fail closed before server construction when no actor is available.
//          4. Read and validate the requested tool profile.
//          5. Build an MCP server scoped to that actor and profile.
//          6. Forward the request through createMcpHandler; if the client only
//             asked for the tool list, strip execution metadata from the response.

import {
  SERVICE_SCOPES,
  type ActorContext,
  type Env,
  type HumanActorContext,
  type ServiceActorContext,
  type ServiceScope,
} from "./types";
import { initializeDatabase } from "./db";
import { resolveMcpActor } from "./auth";
import { buildMcpServer, isMcpToolsListRequest, sanitizeToolsListResponse } from "./mcp";
import { createMcpHandler } from "agents/mcp";
import { verifyServiceActor } from "./service-actor";
import { resolveServiceCredential } from "./service-identities";
import { resolveUserByApiKey } from "./auth";
import { TOOL_PROFILE_HEADER, isToolProfile, type ToolProfile } from "./config";
import { readDeploymentMetadata } from "./mcp-results";

/**
 * A safe, deployment-specific next step for an authentication failure. The
 * server cannot know whether an unknown key came from another workspace, so the
 * message never guesses a reason and never performs a second lookup.
 */
function identityMessage(env: Env, base: string): string {
  const canonical = readDeploymentMetadata(env as unknown as Record<string, unknown>).metadata.canonical_url;
  return canonical
    ? `${base} Use a personal API key as the Bearer token for ${canonical}.`
    : `${base} Use a personal API key as the Bearer token.`;
}

function mcpIdentityError(status: 401 | 503, message: string): Response {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
  if (status === 401) headers["WWW-Authenticate"] = "Bearer";

  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32002, message },
    id: null,
  }), { status, headers });
}

function mcpProfileError(message: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32602,
      message,
      data: { code: "invalid_profile", allowed: ["capture", "review", "full"] },
    },
    id: null,
  }), {
    status: 400,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

function serviceActorFromProps(props: unknown): ServiceActorContext | null {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const value = props as Record<string, unknown>;
  if (value.actorKind !== "service"
      || typeof value.serviceIdentityId !== "string"
      || typeof value.credentialId !== "string"
      || typeof value.ownerUserId !== "string"
      || !Array.isArray(value.scopes)) return null;
  const allowed = new Set<string>(SERVICE_SCOPES);
  if (value.scopes.some((scope) => typeof scope !== "string" || !allowed.has(scope))) return null;
  return {
    kind: "service",
    actorId: value.serviceIdentityId,
    serviceIdentityId: value.serviceIdentityId,
    credentialId: value.credentialId,
    ownerUserId: value.ownerUserId,
    authMethod: typeof value.authMethod === "string" ? value.authMethod : "service_api_key",
    scopes: new Set(value.scopes as ServiceScope[]),
  };
}

/**
 * Resolve the verified actor context for an MCP request. Shared composition:
 * service principals come from OAuthProvider props and are re-verified against
 * the live credential, personal principals from the verified MCP actor.
 */
export async function resolveActorContext(
  request: Request,
  env: Env,
  props: unknown,
): Promise<{ actor: ActorContext; source: string } | null> {
  const service = serviceActorFromProps(props);
  if (service) {
    const verified = await verifyServiceActor(env, service);
    return { actor: verified.actor, source: "service_api_key" };
  }

  const resolution = await resolveMcpActor(request, env, props);
  if (!resolution.ok) return null;
  const row = await env.DB.prepare(
    `SELECT role FROM users WHERE id = ? AND status = 'active'`,
  ).bind(resolution.actor.user_id).first<{ role: string }>();
  if (!row || (row.role !== "admin" && row.role !== "member")) return null;
  const actor: HumanActorContext = {
    kind: "human",
    actorId: resolution.actor.user_id,
    userId: resolution.actor.user_id,
    role: row.role,
    // The trusted auth path, so whoami reports how the caller actually authenticated.
    authMethod: resolution.actor.authMethod,
    scopes: new Set(),
  };
  return { actor, source: resolution.actor.source };
}

/**
 * Resolve the verified ActorContext for a REST request. Personal and service
 * credentials are both accepted; authorization stays with the caller.
 */
export async function resolveRestActorContext(
  request: Request,
  env: Env,
): Promise<ActorContext | null> {
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer && bearer !== env.AUTH_TOKEN) {
    const service = await resolveServiceCredential(bearer, env);
    if (service) {
      const resolved = await resolveActorContext(
        request,
        env,
        {
          actorKind: "service",
          serviceIdentityId: service.serviceIdentityId,
          credentialId: service.credentialId,
          ownerUserId: service.ownerUserId,
          authMethod: service.authMethod,
          scopes: [...service.scopes],
        },
      );
      if (resolved) return resolved.actor;
    }
    const personal = await resolveUserByApiKey(bearer, env);
    if (personal) {
      const row = await env.DB.prepare(
        `SELECT role FROM users WHERE id = ? AND status = 'active'`,
      ).bind(personal.user_id).first<{ role: string }>();
      if (row && (row.role === "admin" || row.role === "member")) {
        return {
          kind: "human",
          actorId: personal.user_id,
          userId: personal.user_id,
          role: row.role,
          authMethod: "personal_api_key",
          scopes: new Set(),
        };
      }
    }
  }

  const legacy = await resolveActorContext(request, env, null);
  return legacy ? legacy.actor : null;
}

/** Read the requested tool profile. Missing means full; an empty or other value is invalid. */
export function readToolProfile(request: Request): { profile: ToolProfile } | { error: string } {
  if (!request.headers.has(TOOL_PROFILE_HEADER)) return { profile: "full" };
  const raw = request.headers.get(TOOL_PROFILE_HEADER);
  if (!isToolProfile(raw)) {
    return { error: `${TOOL_PROFILE_HEADER} must be exactly capture, review or full` };
  }
  return { profile: raw };
}

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      await initializeDatabase(env);
    } catch (error) {
      console.error("Database initialization failed:", error);
      return mcpIdentityError(503, "Shared Living Memory storage is unavailable");
    }

    // An invalid profile is a request-envelope failure: reject before any actor
    // work, and never fall back to a silently different tool set.
    const profileSelection = readToolProfile(request);
    if ("error" in profileSelection) return mcpProfileError(profileSelection.error);

    // OAuthProvider injects the authenticated token principal into ctx.props.
    // Complete, verified legacy user headers may select a narrower per-user
    // actor. Any missing/invalid actor fails before an MCP server exists.
    let resolution: Awaited<ReturnType<typeof resolveActorContext>>;
    try {
      resolution = await resolveActorContext(request, env, ctx.props);
    } catch (error) {
      console.error("MCP actor resolution failed:", error);
      return mcpIdentityError(503, "MCP identity verification is unavailable");
    }

    if (!resolution) {
      return mcpIdentityError(401, identityMessage(env, "Authenticated MCP actor required."));
    }

    const { actor } = resolution;
    const server = buildMcpServer(env, ctx, actor, profileSelection.profile);
    const isToolsList = await isMcpToolsListRequest(request);
    const response = await createMcpHandler(server, {
      authContext: {
        props: {
          actorKind: actor.kind,
          actorId: actor.actorId,
          ownerUserId: actor.kind === "service"
            ? actor.ownerUserId
            : actor.kind === "human" ? actor.userId : actor.systemId,
          actorSource: resolution.source,
          toolProfile: profileSelection.profile,
        },
      },
    })(request, env, ctx);
    return isToolsList ? sanitizeToolsListResponse(response) : response;
  },
};

export { apiHandler };
