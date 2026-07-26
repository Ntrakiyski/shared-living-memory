import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const indexHtml = readFileSync(resolve(process.cwd(), "public/index.html"), "utf8");

function extractInlineFunction(name: string): string {
  const keywordIndex = indexHtml.indexOf(`function ${name}(`);
  expect(keywordIndex, `function ${name} should exist in public/index.html`).toBeGreaterThanOrEqual(0);

  const start = indexHtml.slice(Math.max(0, keywordIndex - 6), keywordIndex) === "async "
    ? keywordIndex - 6
    : keywordIndex;
  const bodyStart = indexHtml.indexOf("{", keywordIndex);
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = bodyStart; i < indexHtml.length; i += 1) {
    const char = indexHtml[i];
    const next = indexHtml[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return indexHtml.slice(start, i + 1);
    }
  }

  throw new Error(`Could not find the end of function ${name}`);
}

type StorageHarness = {
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  values: Map<string, string>;
  writes: Array<[string, string]>;
  removals: string[];
};

function makeStorage(seed: Record<string, string> = {}): StorageHarness {
  const values = new Map(Object.entries(seed));
  const writes: Array<[string, string]> = [];
  const removals: string[] = [];
  return {
    values,
    writes,
    removals,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        writes.push([key, String(value)]);
        values.set(key, String(value));
      },
      removeItem: (key) => {
        removals.push(key);
        values.delete(key);
      },
    },
  };
}

type FakeElement = {
  value: string;
  textContent: string;
  style: Record<string, string>;
  disabled: boolean;
  options: FakeElement[];
};

function fakeElement(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    value: "",
    textContent: "",
    style: {},
    disabled: false,
    options: [],
    ...overrides,
  };
}

function fakeDocument(elements: Record<string, FakeElement>) {
  return {
    getElementById(id: string) {
      const element = elements[id];
      if (!element) throw new Error(`Unexpected element lookup: ${id}`);
      return element;
    },
  };
}

describe("dashboard credential storage", () => {
  it("presents the shared bearer credential as a workspace key", () => {
    expect(indexHtml).toContain('for="auth-token">Workspace key</label>');
    expect(indexHtml).toContain('placeholder="Workspace key"');
    expect(indexHtml).not.toContain("Deployment token");
  });

  it("removes credentials left by older dashboard versions during init", () => {
    const authUrl = fakeElement();
    const storage = makeStorage({
      slm_token: "legacy-workspace-key",
      slm_key: "legacy-user-key",
      slm_auth_mode: "legacy",
      slm_url: "https://brain.example.test",
    });
    const init = new Function(
      "applyTheme",
      "window",
      "document",
      "localStorage",
      `"use strict"; return (${extractInlineFunction("init")});`,
    )(
      vi.fn(),
      { location: { origin: "https://dashboard.example.test" } },
      fakeDocument({ "auth-url": authUrl }),
      storage.storage,
    ) as () => void;

    init();

    expect(storage.removals).toEqual(["slm_token", "slm_key", "slm_auth_mode"]);
    expect(storage.values.has("slm_token")).toBe(false);
    expect(storage.values.has("slm_key")).toBe(false);
    expect(storage.values.has("slm_auth_mode")).toBe(false);
    expect(authUrl.value).toBe("https://brain.example.test");
  });

  it("keeps workspace and user credentials in memory through connect and login", async () => {
    const storage = makeStorage();
    const elements = {
      "auth-url": fakeElement({ value: "https://brain.example.test/" }),
      "auth-token": fakeElement({ value: "workspace-secret" }),
      "auth-error": fakeElement(),
      "auth-connect-btn": fakeElement({ textContent: "Connect" }),
      "auth-connect-step": fakeElement(),
      "auth-user-step": fakeElement(),
      "auth-username": fakeElement({ value: "alice" }),
      "auth-login-username": fakeElement(),
      "auth-key": fakeElement({ value: "slm_test.user-secret" }),
    };
    const document = fakeDocument(elements);
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const showApp = vi.fn();
    const connectHarness = new Function(
      "document",
      "fetch",
      "localStorage",
      "loadUserAccounts",
      "window",
      `"use strict";
       let WORKER_URL = "";
       let AUTH_TOKEN = "";
       const connect = (${extractInlineFunction("connect")});
       return { connect, state: () => ({ WORKER_URL, AUTH_TOKEN }) };`,
    )(
      document,
      fetch,
      storage.storage,
      vi.fn(),
      { location: { origin: "https://dashboard.example.test" } },
    ) as {
      connect(): Promise<void>;
      state(): { WORKER_URL: string; AUTH_TOKEN: string };
    };

    await connectHarness.connect();

    expect(connectHarness.state()).toEqual({
      WORKER_URL: "https://brain.example.test",
      AUTH_TOKEN: "workspace-secret",
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://brain.example.test/api/users",
      { headers: { Authorization: "Bearer workspace-secret" } },
    );
    expect(elements["auth-token"].value).toBe("");

    const loginHarness = new Function(
      "document",
      "fetch",
      "localStorage",
      "showApp",
      `"use strict";
       const WORKER_URL = "https://brain.example.test";
       const AUTH_TOKEN = "workspace-secret";
       let CURRENT_USERNAME = "";
       let USER_API_KEY = "";
       const loginWithKey = (${extractInlineFunction("loginWithKey")});
       return { loginWithKey, state: () => ({ CURRENT_USERNAME, USER_API_KEY }) };`,
    )(document, fetch, storage.storage, showApp) as {
      loginWithKey(): Promise<void>;
      state(): { CURRENT_USERNAME: string; USER_API_KEY: string };
    };

    await loginHarness.loginWithKey();

    expect(loginHarness.state()).toEqual({
      CURRENT_USERNAME: "alice",
      USER_API_KEY: "slm_test.user-secret",
    });
    expect(elements["auth-key"].value).toBe("");
    expect(elements["auth-login-username"].value).toBe("alice");
    expect(showApp).toHaveBeenCalledOnce();
    expect(storage.writes).toEqual([
      ["slm_url", "https://brain.example.test"],
      ["slm_url", "https://brain.example.test"],
      ["slm_username", "alice"],
    ]);
  });

  it("contains no persistent writes for legacy credential keys", () => {
    expect(indexHtml).not.toMatch(
      /localStorage\s*\.\s*setItem\s*\(\s*(["'])(?:slm_token|slm_key|slm_auth_mode)\1/,
    );
  });
});

type RenderNode = {
  kind: "element" | "text";
  tagName: string;
  className: string;
  textContent: string;
  children: RenderNode[];
  appendChild(child: RenderNode): RenderNode;
};

function renderNode(kind: "element" | "text", value = ""): RenderNode {
  return {
    kind,
    tagName: kind === "element" ? value : "",
    className: "",
    textContent: kind === "text" ? value : "",
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

function renderedText(node: RenderNode): string {
  return node.kind === "text"
    ? node.textContent
    : node.children.length > 0
      ? node.children.map(renderedText).join("")
      : node.textContent;
}

describe("Remember message rendering", () => {
  it("renders raw payload as text while preserving hashtag spans", () => {
    const createdElements: RenderNode[] = [];
    const document = {
      createTextNode(text: string) {
        return renderNode("text", text);
      },
      createElement(tagName: string) {
        const node = renderNode("element", tagName);
        createdElements.push(node);
        return node;
      },
    };
    const appendHashtagText = new Function(
      "document",
      `"use strict"; return (${extractInlineFunction("appendHashtagText")});`,
    )(document) as (container: RenderNode, text: string) => void;
    const container = renderNode("element", "div");
    const payload = '<img src=x onerror="globalThis.xss=1"> before #audit after #two';

    appendHashtagText(container, payload);

    expect(renderedText(container)).toBe(payload);
    expect(createdElements.map((node) => node.tagName)).toEqual(["span", "span"]);
    expect(createdElements.map((node) => [node.className, node.textContent])).toEqual([
      ["hashtag", "#audit"],
      ["hashtag", "#two"],
    ]);
    expect(container.children[0]).toMatchObject({
      kind: "text",
      textContent: '<img src=x onerror="globalThis.xss=1"> before ',
    });
  });

  it("routes the Remember input through the safe hashtag renderer", () => {
    const sendRemember = extractInlineFunction("sendRemember");

    expect(sendRemember).toContain("appendHashtagText(userRow, raw)");
    expect(sendRemember).not.toMatch(/userRow\s*\.\s*innerHTML\s*=/);
  });
});
