// Test-only subprocess transport. Production scripts have no loopback bypass.
const realFetch = globalThis.fetch;
const fixture = new URL(process.env.SLM_TEST_FIXTURE_ORIGIN);
if (fixture.hostname !== "127.0.0.1" || fixture.protocol !== "http:") throw new Error("invalid fixture origin");
globalThis.fetch = (input, init = {}) => {
  const target = new URL(input);
  if (!["api.cloudflare.com", "staging.example.test"].includes(target.hostname)) throw new Error("unexpected fixture target");
  const rewritten = new URL(target.pathname + target.search, fixture);
  const headers = new Headers(init.headers);
  headers.set("x-fixture-host", target.hostname);
  return realFetch(rewritten, { ...init, headers });
};
