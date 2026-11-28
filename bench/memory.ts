/**
 * Memory of a fresh process doing what `rulebase mcp` does at startup: open the
 * cache, index (warm), answer a query. Run by bench.ts in a child process so the
 * benchmark's own garbage doesn't count.
 */
import { Session } from "../src/session.ts";

const [workspace, cacheFile] = process.argv.slice(2);
const session = new Session(workspace, { cacheFile });
const start = performance.now();
session.kb().findTerms({ query: "rate" });
const ms = Math.round(performance.now() - start);
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
await new Promise((resolve) => setTimeout(resolve, 100));
gc?.();
const usage = process.memoryUsage();
console.log(
  JSON.stringify({
    startMs: ms,
    rssMb: Math.round(usage.rss / 1048576),
    heapMb: Math.round(usage.heapUsed / 1048576),
  }),
);
session.close();
