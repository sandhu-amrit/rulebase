#!/usr/bin/env node
// Silence Node's "SQLite is experimental" warning before anything loads node:sqlite.
// Other warnings still print.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite/i.test(text))
        return;
    return emitWarning(warning, ...rest);
});
const { main } = await import("./main.js");
process.exitCode = await main(process.argv.slice(2));
export {};
