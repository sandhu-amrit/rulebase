import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { anonymizeWorkspace } from "./anonymize.js";
import { runGates } from "./check.js";
import { serveMcp } from "./mcp.js";
import { renderReport } from "./report.js";
import { Session } from "./session.js";
import { cacheDir, cacheFileFor } from "./store.js";
import { TOOLS } from "./tools.js";
import { VERSION } from "./version.js";
const HELP = `rulebase ${VERSION}: a read-only knowledge base over an IBM ODM Rule Designer workspace

Usage:
  rulebase mcp <workspace>                 Serve the MCP tools over stdio (what an AI assistant starts)
  rulebase index <workspace> [--full]      Index (incrementally; --full re-reads every file) and print a summary
  rulebase check <workspace> [--json]      Run every quality gate; exits 1 if one fails
  rulebase report <workspace> [-o file]    Write a static HTML report (default rulebase-report.html)
  rulebase drift <workspace>               What changed since the previous index
  rulebase query <workspace> <tool> [json] Call one tool and print its JSON answer
  rulebase anonymize <workspace> <out>     Copy the workspace with business words, values and names replaced
                                           (structure kept, then verified by indexing both)
  rulebase clean [<workspace> | --all]     Delete the cache for a workspace, or every cache
  rulebase --version

Options:
  --cache <file>   Use this SQLite cache file instead of the per-user cache folder

Tools: ${TOOLS.map((tool) => tool.name).join(", ")}
Cache folder: ${cacheDir()}`;
export async function main(argv) {
    const args = [...argv];
    const cacheAt = args.indexOf("--cache");
    const cacheFile = cacheAt >= 0 ? args.splice(cacheAt, 2)[1] : undefined;
    const command = args.shift();
    if (!command || command === "help" || command === "--help" || command === "-h") {
        console.log(HELP);
        return command ? 0 : 1;
    }
    if (command === "--version" || command === "-v") {
        console.log(VERSION);
        return 0;
    }
    if (command === "clean") {
        if (args[0] === "--all") {
            fs.rmSync(cacheDir(), { recursive: true, force: true });
            console.log(`removed ${cacheDir()}`);
            return 0;
        }
        if (!args[0])
            return usage("clean needs a workspace or --all");
        const file = cacheFile ?? cacheFileFor(args[0]);
        for (const suffix of ["", "-wal", "-shm"])
            fs.rmSync(file + suffix, { force: true });
        console.log(`removed ${file}`);
        return 0;
    }
    const workspace = args.shift();
    if (!workspace)
        return usage(`${command} needs a workspace folder`);
    if (command === "anonymize") {
        const out = args.shift();
        if (!out)
            return usage("anonymize needs an output folder");
        try {
            const result = anonymizeWorkspace(workspace, out);
            console.log(`wrote ${result.files} files to ${result.out} (${result.words} words replaced)`);
            console.log("shape check, original vs anonymized:");
            for (const row of result.comparison) {
                console.log(`  ${row.original === row.anonymized ? "same" : "DIFF"}  ${row.metric.padEnd(18)} ${String(row.original).padStart(7)} ${String(row.anonymized).padStart(7)}`);
            }
            console.log(result.ok
                ? "The anonymized copy indexes the same way. Review it before sharing: comments and free text are replaced word by word, not removed."
                : "The copies differ: the anonymizer changed meaning somewhere. Please report the DIFF lines (they contain no business data).");
            return result.ok ? 0 : 1;
        }
        catch (error) {
            console.error(`rulebase: ${error instanceof Error ? error.message : String(error)}`);
            return 2;
        }
    }
    try {
        if (command === "mcp") {
            await serveMcp(workspace, { cacheFile });
            return 0;
        }
        const session = new Session(workspace, { cacheFile });
        try {
            switch (command) {
                case "index":
                    return index(session, args.includes("--full"));
                case "check":
                    return check(session, args.includes("--json"));
                case "report":
                    return report(session, args);
                case "drift":
                    console.log(JSON.stringify(session.drift(), null, 2));
                    return 0;
                case "query":
                    return query(session, args);
                default:
                    return usage(`unknown command '${command}'`);
            }
        }
        finally {
            session.close();
        }
    }
    catch (error) {
        console.error(`rulebase: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
    }
}
function usage(message) {
    console.error(`rulebase: ${message}\n\n${HELP}`);
    return 2;
}
function index(session, full) {
    const { kb, stats } = session.rebuild(full);
    const overview = kb.listDecisionServices();
    console.log(`${kb.meta.decisionService}: ${kb.meta.projects.length} project(s), ${stats.files} files`);
    console.log(`  parsed ${stats.parsed}, reused ${stats.reused}; scan ${stats.scanMs} ms, parse ${stats.parseMs} ms, link ${stats.linkMs} ms`);
    console.log(`  ${Object.entries(overview.counts)
        .filter(([, value]) => value)
        .map(([key, value]) => `${key} ${value}`)
        .join(", ")}`);
    const errors = kb.warnings().filter((warning) => warning.severity === "error");
    if (errors.length) {
        console.log(`  ${errors.length} error(s):`);
        for (const warning of errors.slice(0, 20))
            console.log(`    ${warning.path}: ${warning.message}`);
        if (errors.length > 20)
            console.log(`    ... ${errors.length - 20} more (rulebase report lists all)`);
    }
    const drift = session.drift();
    if (drift.from)
        console.log(`  drift: +${drift.added.length} -${drift.removed.length} ~${drift.changed.length}`);
    console.log(`  cache ${session.store.file} (${Math.round(session.store.sizeBytes() / 1024)} KB)`);
    return errors.length ? 1 : 0;
}
function check(session, json) {
    const kb = session.kb();
    const gates = runGates(kb);
    if (json) {
        console.log(JSON.stringify({ decisionService: kb.meta.decisionService, gates }, null, 2));
    }
    else {
        for (const gate of gates) {
            console.log(`${gate.pass ? "PASS" : "FAIL"} ${gate.label}: ${gate.detail}`);
            for (const failure of gate.failures?.slice(0, 10) ?? [])
                console.log(`       ${failure}`);
        }
    }
    return gates.every((gate) => gate.pass) ? 0 : 1;
}
function report(session, args) {
    const outAt = args.indexOf("-o");
    const out = path.resolve(outAt >= 0 ? args[outAt + 1] : "rulebase-report.html");
    const kb = session.kb();
    const gates = runGates(kb);
    fs.writeFileSync(out, renderReport(kb, gates, session.drift()));
    console.log(`wrote ${out}`);
    return gates.every((gate) => gate.pass) ? 0 : 1;
}
function query(session, args) {
    const name = args.shift();
    const tool = TOOLS.find((item) => item.name === name);
    if (!tool)
        return usage(`unknown tool '${name}'. Tools: ${TOOLS.map((item) => item.name).join(", ")}`);
    const raw = args.length ? JSON.parse(args.join(" ")) : {};
    const input = z.object(tool.input).strict().parse(raw);
    console.log(JSON.stringify(tool.run(session, input), null, 2));
    return 0;
}
