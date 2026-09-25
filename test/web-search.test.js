const test = require("node:test");
const assert = require("node:assert/strict");
const { createWebSearchCapability, safePublicQuery } = require("../ai/capabilities/web-search");
const { routeTaskIntent } = require("../ai/runtime/intent-router");

test("web search public query and source evidence are bounded", async () => {
  let payload;
  const cap = createWebSearchCapability({
    client: { post: async (_path, request) => {
      payload = request;
      return { usage: { server_tool_use: { web_search_requests: 1 } }, choices: [{ message: { content: "Jawaban [1]", annotations: [{ type: "url_citation", url_citation: { url: "https://example.org/page", title: "Example", content: "Evidence" } }] } }] };
    } },
    limiter: { reserve: () => {} },
  });
  const result = await cap.handler({ query: "sejarah kota Jayapura" }, { taskId: "t1", engineMode: "agent" });
  assert.equal(payload.max_tool_calls, 1);
  assert.equal(payload.tools[0].parameters.max_uses, 1);
  assert.equal(result.sources[0].url, "https://example.org/page");
  assert.equal((await cap.verifier(result)).ok, true);
  assert.throws(() => safePublicQuery("api_key=secret"), /private/);
  assert.throws(() => safePublicQuery("nomor 628123456789"), /private/);
  await assert.rejects(() => cap.handler({ query: "abc" }, { engineMode: "shadow" }), /shadow/);
});

test("web search fails closed without actual search and citations", async () => {
  const cap = createWebSearchCapability({ client: { post: async () => ({ usage: { server_tool_use: { web_search_requests: 0 } }, choices: [{ message: { content: "made up" } }] }) }, limiter: { reserve: () => {} } });
  await assert.rejects(() => cap.handler({ query: "publik" }, { engineMode: "agent" }), /not_executed/);
  const prior = process.env.AGENT_WEB_SEARCH_ENABLED;
  try {
    process.env.AGENT_WEB_SEARCH_ENABLED = "true";
    assert.equal(routeTaskIntent("/task cari web sejarah kota Jayapura")?.intent, "web_search");
    assert.equal(routeTaskIntent("/task cari web "), null);
    assert.equal(routeTaskIntent("/task cari web api_key=secret"), null);
  } finally {
    if (prior === undefined) delete process.env.AGENT_WEB_SEARCH_ENABLED;
    else process.env.AGENT_WEB_SEARCH_ENABLED = prior;
  }
});
