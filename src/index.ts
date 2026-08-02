/**
 * index.ts — Production Cloudflare Worker entrypoint.
 *
 * Purpose: Wire apiHandler and defaultHandler through OAuthProvider without
 * exposing ordinary module values as named Worker entrypoints. Cloudflare
 * interprets named exports from this module as additional entrypoints.
 * Input: Incoming HTTP requests and scheduled events.
 * Output: OAuthProvider-wrapped fetch handler and nightly cron handler.
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import { apiHandler } from "./api-handler";
import { defaultHandler } from "./routes";
import { resolveUserByApiKey } from "./auth";
import { resolveServiceCredential } from "./service-identities";
import { initializeDatabase } from "./db";
import {
  runNightlyCompression,
  runGraphPass,
  detectCrossUserContradictions,
} from "./lifecycle";
import { runScheduledIntegrationSync } from "./integrations-mirror";
import { drainVectorCleanupQueue } from "./vector-cleanup";
import { resumePendingDeactivations } from "./deactivation";
import { reconcileMandatoryAuditCompletions } from "./mandatory-audit";
import { flagPendingErasures } from "./erasure";
import { reconcilePendingOverlapAwareness } from "./awareness-events";

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: apiHandler as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // Personal API keys may be used directly by non-browser MCP clients. The
  // workspace key is deliberately not a principal: it can gate legacy
  // transport, but it must never collapse every client into one user namespace.
  resolveExternalToken: async ({ token, env }) => {
    const typedEnv = env as Env;
    if (token === typedEnv.AUTH_TOKEN) return null;
    await initializeDatabase(typedEnv);
    const principal = await resolveUserByApiKey(token, typedEnv);
    if (principal) return { props: { actorKind: "human", userId: principal.user_id } };
    const service = await resolveServiceCredential(token, typedEnv);
    return service ? {
      props: {
        actorKind: "service",
        serviceIdentityId: service.serviceIdentityId,
        credentialId: service.credentialId,
        ownerUserId: service.ownerUserId,
        authMethod: service.authMethod,
        scopes: [...service.scopes],
      },
    } : null;
  },
});

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    oauthProvider.fetch(req, env as any, ctx),
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runNightlyCompression(env, ctx));
    ctx.waitUntil(runGraphPass(env, ctx));
    ctx.waitUntil(
      detectCrossUserContradictions(env).catch((error) =>
        console.error(
          "detectCrossUserContradictions failed (non-fatal):",
          error,
        ),
      ),
    );
    ctx.waitUntil(runScheduledIntegrationSync(env));
    ctx.waitUntil(
      initializeDatabase(env)
        .then(() => drainVectorCleanupQueue(env))
        .catch((error) => console.error("Vector cleanup reconciliation failed (non-fatal):", error)),
    );
    ctx.waitUntil(
      initializeDatabase(env)
        .then(() => resumePendingDeactivations(env))
        .catch((error) => console.error("User deactivation reconciliation failed (non-fatal):", error)),
    );
    ctx.waitUntil(
      initializeDatabase(env)
        .then(() => reconcilePendingOverlapAwareness(env))
        .catch((error) => console.error("Overlap-awareness reconciliation failed (non-fatal):", error)),
    );
    ctx.waitUntil(
      initializeDatabase(env)
        .then(() => reconcileMandatoryAuditCompletions(env))
        .catch((error) => console.error("Mandatory-audit reconciliation failed (non-fatal):", error)),
    );
    ctx.waitUntil(
      initializeDatabase(env)
        .then(() => flagPendingErasures(env))
        .catch((error) => console.error("Erasure stale-sweep failed (non-fatal):", error)),
    );
  },
};
