const { setupSimulatorEnv } = require("./simulator-setup");
const simulator = setupSimulatorEnv();
require("dotenv").config({ quiet: true });
const { createWebSearchCapability } = require("../ai/capabilities/web-search");

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY belum tersedia");
  const capability = createWebSearchCapability();
  const result = await capability.handler({ query: "official Node.js 20 end of life date" }, { taskId: "live-web-search-probe", engineMode: "agent" });
  if (!(await capability.verifier(result)).ok) throw new Error("web_search_unverified");
  console.log(JSON.stringify({ ok: true, sourceCount: result.sources.length, hasAnswer: Boolean(result.answer), searchBound: 1 }));
}

main().catch((error) => {
  console.error("web search simulation failed:", error.message);
  process.exitCode = 1;
}).finally(() => simulator.cleanup());
