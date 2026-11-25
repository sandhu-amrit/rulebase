#!/usr/bin/env node
// Silence Node's "SQLite is experimental" warning before anything loads node:sqlite.
// Other warnings still print.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite/i.test(text)) return;
  return (emitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
