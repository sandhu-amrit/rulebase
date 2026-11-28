const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
export function renderReport(kb, gates, drift) {
    const overview = kb.listDecisionServices();
    const errors = kb.warnings().filter((warning) => warning.severity === "error");
    const infos = kb.warnings().filter((warning) => warning.severity === "info");
    const failed = gates.filter((gate) => !gate.pass);
    const counts = Object.entries(overview.counts).filter(([, value]) => value);
    const skipped = Object.entries(kb.meta.skipped);
    const row = (cells) => `<tr>${cells.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`;
    const list = (items) => items.length
        ? `<ul>${items.map((item) => `<li>${esc(item.name)} <span class="muted">${esc(item.path)}</span></li>`).join("")}</ul>`
        : `<p class="muted">None.</p>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rulebase: ${esc(kb.meta.decisionService)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1f; --muted:#6b6b70; --bg:#fff; --line:#e3e3e6; --ok:#1a7f37; --bad:#c62828; --chip:#f4f4f6; }
  @media (prefers-color-scheme: dark) { :root { --fg:#ececef; --muted:#9a9aa2; --bg:#151517; --line:#2c2c30; --ok:#4cc26b; --bad:#ff6b6b; --chip:#212125; } }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); margin: 0; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 36px 0 10px; }
  .muted { color: var(--muted); } .ok { color: var(--ok); } .bad { color: var(--bad); }
  .status { display:inline-block; margin-top:12px; padding:4px 10px; border-radius:999px; background:var(--chip); font-weight:600; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 13px; color: var(--muted); font-weight: 600; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .tile { background: var(--chip); border-radius: 8px; padding: 10px 12px; } .tile b { display:block; font-size: 20px; font-variant-numeric: tabular-nums; }
  code, .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
  details { margin: 4px 0; } ul { margin: 6px 0; padding-left: 20px; }
</style>
</head>
<body><main>
<h1>${esc(kb.meta.decisionService)}</h1>
<div class="muted">Indexed ${esc(kb.meta.indexedAt)}${kb.meta.branch ? ` · branch ${esc(kb.meta.branch)}` : ""} · ${kb.meta.files} files · ${esc(kb.meta.projects.map((project) => project.name).join(", "))}</div>
<div class="status ${failed.length ? "bad" : "ok"}">${failed.length ? `${failed.length} gate(s) failed` : "All gates pass"}</div>

<h2>Contents</h2>
<div class="grid">${counts.map(([key, value]) => `<div class="tile"><b>${esc(value)}</b><span class="muted">${esc(key)}</span></div>`).join("")}</div>

<h2>Quality gates</h2>
<table><tr><th></th><th>Gate</th><th>Result</th></tr>
${gates
        .map((gate) => `<tr><td class="${gate.pass ? "ok" : "bad"}">${gate.pass ? "PASS" : "FAIL"}</td><td>${esc(gate.label)}</td><td>${esc(gate.detail)}${gate.failures?.length
        ? `<details><summary>${gate.failures.length} item(s)</summary><ul>${gate.failures.map((item) => `<li class="mono">${esc(item)}</li>`).join("")}</ul></details>`
        : ""}</td></tr>`)
        .join("\n")}
</table>

<h2>Errors <span class="muted">(${errors.length})</span></h2>
${errors.length ? `<table><tr><th>File</th><th>Problem</th></tr>${errors.map((warning) => row([warning.path, warning.message])).join("")}</table>` : `<p class="muted">No file failed to parse.</p>`}

<h2>Not indexed</h2>
${skipped.length ? `<table><tr><th>Kind</th><th>Files</th></tr>${skipped.map(([key, value]) => row([key, value])).join("")}</table>` : `<p class="muted">Every file was indexed.</p>`}

<h2>Drift</h2>
<p class="muted">${drift.from ? `Since ${esc(drift.from.indexedAt)}${drift.from.branch ? ` (branch ${esc(drift.from.branch)})` : ""}` : "No previous index to compare with."}</p>
<h3>Added</h3>${list(drift.added)}
<h3>Changed</h3>${list(drift.changed)}
<h3>Removed</h3>${list(drift.removed)}
${drift.vocabulary.added.length || drift.vocabulary.removed.length ? `<h3>Vocabulary</h3><ul>${drift.vocabulary.added.map((item) => `<li class="ok">+ ${esc(item)}</li>`).join("")}${drift.vocabulary.removed.map((item) => `<li class="bad">− ${esc(item)}</li>`).join("")}</ul>` : ""}

<h2>Notes <span class="muted">(${infos.length})</span></h2>
${infos.length ? `<details><summary>Show notes</summary><table><tr><th>File</th><th>Note</th></tr>${infos.map((warning) => row([warning.path, warning.message])).join("")}</table></details>` : `<p class="muted">None.</p>`}
</main></body></html>
`;
}
