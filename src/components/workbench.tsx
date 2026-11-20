import { useMemo, useState } from "react";
import { loadMiniloan } from "@/lib/odm/fixtures";
import { buildKnowledgeBase, type KnowledgeBase, type KnowledgeSnapshot } from "@/lib/odm/kb";
import { driftReport } from "@/lib/odm/drift";
import type { Artifact, DriftReport, Grounding, SnapshotVersion, SourceFile } from "@/lib/odm/types";

type Tab = "pipeline" | "rules" | "vocabulary" | "impact" | "agent" | "versions";

const TABS: { id: Tab; label: string }[] = [
  { id: "pipeline", label: "Pipeline" },
  { id: "rules", label: "Rules" },
  { id: "vocabulary", label: "Vocabulary" },
  { id: "impact", label: "Impact" },
  { id: "agent", label: "Agent" },
  { id: "versions", label: "Versions" },
];

const PROMPTS = [
  "Reject loans when the borrower is over-leveraged",
  "Credit score below 200 should stop the loan",
  "Reject the loan when the vibe score of the applicant is low",
];

export function Workbench() {
  const sample = useMemo(() => loadMiniloan(), []);
  const [files, setFiles] = useState<SourceFile[]>(sample);
  const [sourceLabel, setSourceLabel] = useState("Miniloan sample");
  const [tab, setTab] = useState<Tab>("pipeline");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ruleQuery, setRuleQuery] = useState("");
  const [impactSeed, setImpactSeed] = useState("eligibility");
  const [requirement, setRequirement] = useState(PROMPTS[0]);
  const [grounding, setGrounding] = useState<Grounding | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [versions, setVersions] = useState<SnapshotVersion[]>([]);
  const [drift, setDrift] = useState<DriftReport | null>(null);

  const kb = useMemo(() => buildKnowledgeBase(files, { commit: sourceLabel }), [files, sourceLabel]);
  const selected = kb.artifacts.find((item) => item.id === selectedId) ?? null;
  const rules = kb.artifacts.filter((item) =>
    ["actionRule", "decisionTable", "decisionTree", "function", "technicalRule", "ruleflow"].includes(item.type),
  );
  const filtered = ruleQuery.trim()
    ? kb.search(ruleQuery).map((hit) => hit.artifact)
    : rules;
  const flow = kb.artifacts.find((item) => item.type === "ruleflow");

  async function onUpload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setReadError(null);
    try {
      const next: SourceFile[] = [];
      for (const file of list) {
        const rel = file.webkitRelativePath || file.name;
        if (file.size > 1_500_000) continue;
        const content = await file.text();
        next.push({ path: rel, content });
      }
      if (!next.length) {
        setReadError("No readable files in that folder.");
        return;
      }
      setFiles(next);
      setSourceLabel(list[0].webkitRelativePath.split("/")[0] || "Uploaded project");
      setGrounding(null);
      setSelectedId(null);
      setTab("pipeline");
    } catch (error) {
      setReadError(error instanceof Error ? error.message : "Could not read that folder.");
    }
  }

  function record(accepted: boolean) {
    const feedback = kb.recordFeedback(requirement, accepted);
    setGrounding(kb.ground(requirement));
    void feedback;
  }

  function saveVersion() {
    const version: SnapshotVersion = {
      id: `v-${Date.now()}`,
      savedAt: new Date().toISOString(),
      label: sourceLabel,
      artifactCount: kb.artifacts.length,
      termCount: kb.terms.length,
      commit: kb.commit,
    };
    const next = [version, ...versions].slice(0, 12);
    setVersions(next);
    const stored = readStoredSnapshots();
    stored[version.id] = kb.snapshot();
    writeStoredSnapshots(stored);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("rulebase.versions", JSON.stringify(next));
    }
    setTab("versions");
  }

  function compare(version: SnapshotVersion) {
    const stored = readStoredSnapshots();
    const previous = stored[version.id];
    if (!previous) return;
    setDrift(driftReport(kb.snapshot(), previous));
  }

  function exportSnapshot() {
    const blob = new Blob([JSON.stringify(kb.snapshot(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "rulebase.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-6 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted">ODM knowledge pipeline</p>
          <h1 className="mt-1 text-3xl font-medium tracking-tight text-ink">Rulebase</h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Parses a Rule Designer project into rules, vocabulary, and ruleflow links. An agent calls these tools.
            It does not invent terms.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="h-11 rounded-control bg-accent px-4 text-sm font-medium text-accent-fg"
            onClick={() => {
              setFiles(sample);
              setSourceLabel("Miniloan sample");
              setGrounding(null);
              setSelectedId(null);
            }}
          >
            Load sample
          </button>
          <label className="inline-flex h-11 cursor-pointer items-center rounded-control border border-line bg-surface px-4 text-sm font-medium">
            Open project folder
            <input
              className="sr-only"
              type="file"
              multiple
              onChange={(event) => {
                void onUpload(event.target.files);
                event.target.value = "";
              }}
              {...{ webkitdirectory: "", directory: "" }}
            />
          </label>
          <button
            type="button"
            className="h-11 rounded-control border border-line bg-surface px-4 text-sm font-medium"
            onClick={exportSnapshot}
          >
            Export JSON
          </button>
        </div>
      </header>

      <section className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted">
        <span className="rounded-control bg-surface px-3 py-1 font-medium text-ink">{sourceLabel}</span>
        <span>{kb.artifacts.length} artifacts</span>
        <span>{kb.terms.length} terms</span>
        <span>{kb.edges.length} links</span>
        <span>{kb.gates.filter((gate) => gate.pass).length}/{kb.gates.length} gates</span>
        {readError ? <span className="text-bad">{readError}</span> : null}
      </section>

      <nav className="mt-6 flex gap-2 overflow-x-auto" aria-label="Sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={
              tab === item.id
                ? "h-11 shrink-0 rounded-control bg-accent px-4 text-sm font-medium text-accent-fg"
                : "h-11 shrink-0 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink"
            }
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {tab === "pipeline" ? <Pipeline kb={kb} flow={flow} /> : null}
        {tab === "rules" ? (
          <Rules
            artifacts={filtered}
            query={ruleQuery}
            onQuery={setRuleQuery}
            selected={selected}
            onSelect={(id) => setSelectedId(id)}
          />
        ) : null}
        {tab === "vocabulary" ? <Vocabulary kb={kb} /> : null}
        {tab === "impact" ? <Impact kb={kb} seed={impactSeed} onSeed={setImpactSeed} /> : null}
        {tab === "agent" ? (
          <Agent
            requirement={requirement}
            onRequirement={setRequirement}
            grounding={grounding}
            onRun={() => setGrounding(kb.ground(requirement))}
            onAccept={() => record(true)}
            onReject={() => record(false)}
          />
        ) : null}
        {tab === "versions" ? (
          <Versions versions={versions} drift={drift} onSave={saveVersion} onCompare={compare} />
        ) : null}
      </div>
    </main>
  );
}

function Pipeline({ kb, flow }: { kb: KnowledgeBase; flow?: Artifact }) {
  const counts = countTypes(kb);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="text-lg font-medium">What was indexed</h2>
        <ul className="mt-4 grid grid-cols-2 gap-3">
          {counts.map((item) => (
            <li key={item.label} className="rounded-control border border-line px-3 py-3">
              <p className="font-mono text-2xl font-medium tabular-nums">{item.count}</p>
              <p className="text-sm text-muted">{item.label}</p>
            </li>
          ))}
        </ul>
        {kb.warnings.length ? (
          <ul className="mt-4 space-y-1 text-sm text-warn">
            {kb.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted">No parse warnings. Provenance is the file path plus the ODM UUID.</p>
        )}
      </section>
      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="text-lg font-medium">Quality gates</h2>
        <ul className="mt-4 space-y-3">
          {kb.gates.map((gate) => (
            <li key={gate.id} className="flex gap-3">
              <span className={gate.pass ? "mt-0.5 text-sm font-medium text-ok" : "mt-0.5 text-sm font-medium text-bad"}>
                {gate.pass ? "Pass" : "Fail"}
              </span>
              <span>
                <span className="block text-sm font-medium">{gate.label}</span>
                <span className="block text-sm text-muted">{gate.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {flow ? (
        <section className="rounded-card border border-line bg-surface p-5 lg:col-span-2">
          <h2 className="text-lg font-medium">Ruleflow {flow.name}</h2>
          <p className="mt-1 text-sm text-muted">Selection scope is what impact analysis is allowed to follow.</p>
          <FlowMap artifact={flow} />
        </section>
      ) : null}
      <p className="text-xs text-faint lg:col-span-2">
        Sample project is the Apache-2.0 Miniloan service from DecisionsDev/odm-on-cloud-getting-started. Upload replaces it
        for this session only.
      </p>
    </div>
  );
}

function FlowMap({ artifact }: { artifact: Artifact }) {
  const taskById = new Map((artifact.tasks ?? []).map((task) => [task.identifier, task]));
  const nodeTask = new Map((artifact.nodes ?? []).map((node) => [node.id, node.task]));
  const transitions = artifact.transitions ?? [];
  const start = artifact.nodes?.find((node) => taskById.get(node.task)?.kind === "start");
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = start ? [start.id] : (artifact.nodes ?? []).map((node) => node.id);
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    for (const transition of transitions.filter((item) => item.source === id)) queue.push(transition.target);
  }
  return (
    <ol className="mt-4 space-y-3">
      {ordered.map((nodeId, index) => {
        const task = taskById.get(nodeTask.get(nodeId) ?? "");
        const outgoing = transitions.filter((item) => item.source === nodeId);
        if (!task) return null;
        return (
          <li key={nodeId} className="rounded-control border border-line px-4 py-3">
            <p className="text-sm font-medium">
              {index + 1}. {task.kind === "rule" ? task.identifier : task.kind}
              {task.algorithm ? <span className="ml-2 font-normal text-muted">{task.algorithm}</span> : null}
            </p>
            {task.packages.length ? (
              <p className="mt-1 text-sm text-muted">Selects package {task.packages.join(", ")}</p>
            ) : null}
            {task.filter ? <p className="mt-1 font-mono text-xs text-ink">where {task.filter}</p> : null}
            {task.actions ? <p className="mt-1 font-mono text-xs text-ink">{task.actions}</p> : null}
            {outgoing.filter((item) => item.condition).map((item) => (
              <p key={item.id} className="mt-1 text-sm text-muted">
                If {item.condition} → {taskById.get(nodeTask.get(item.target) ?? "")?.identifier ?? "next"}
              </p>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function Rules({
  artifacts,
  query,
  onQuery,
  selected,
  onSelect,
}: {
  artifacts: Artifact[];
  query: string;
  onQuery: (value: string) => void;
  selected: Artifact | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <div>
        <label className="block text-sm font-medium" htmlFor="rule-search">
          Search rules
        </label>
        <input
          id="rule-search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="credit score, debt, approval"
          className="mt-2 h-11 w-full rounded-control border border-line bg-surface px-3 text-sm"
        />
        <ul className="mt-3 max-h-[32rem] space-y-1 overflow-auto">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                onClick={() => onSelect(artifact.id)}
                className={
                  selected?.id === artifact.id
                    ? "w-full rounded-control bg-accent px-3 py-3 text-left text-accent-fg"
                    : "w-full rounded-control border border-line bg-surface px-3 py-3 text-left"
                }
              >
                <span className="block text-sm font-medium">{artifact.name}</span>
                <span className={selected?.id === artifact.id ? "block text-xs opacity-80" : "block text-xs text-muted"}>
                  {artifact.type} · {artifact.package || "root"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <article className="rounded-card border border-line bg-surface p-5">
        {selected ? <ArtifactBody artifact={selected} /> : <p className="text-sm text-muted">Select a rule, table, or ruleflow.</p>}
      </article>
    </div>
  );
}

function ArtifactBody({ artifact }: { artifact: Artifact }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-faint">{artifact.type}</p>
      <h2 className="mt-1 text-xl font-medium">{artifact.name}</h2>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Package</dt>
          <dd>{artifact.package || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Decision service</dt>
          <dd>{artifact.decisionServices.join(", ") || "—"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted">Provenance</dt>
          <dd className="font-mono text-xs">{artifact.filePath}</dd>
          <dd className="font-mono text-xs text-muted">{artifact.uuid}</dd>
        </div>
      </dl>
      {artifact.bal ? (
        <pre className="mt-4 overflow-auto rounded-control bg-bg p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{artifact.bal}</pre>
      ) : null}
      {artifact.vocabularyTermsUsed.length ? (
        <p className="mt-3 text-sm text-muted">Terms: {artifact.vocabularyTermsUsed.join(" · ")}</p>
      ) : null}
      {artifact.rows?.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-2 pr-3 font-medium">Row</th>
                <th className="py-2 font-medium">Rendered from columns</th>
              </tr>
            </thead>
            <tbody>
              {artifact.rows.map((row) => (
                <tr key={row.index} className="border-b border-line">
                  <td className="py-2 pr-3 tabular-nums">{row.index}</td>
                  <td className="py-2">{row.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Vocabulary({ kb }: { kb: KnowledgeBase }) {
  const [query, setQuery] = useState("");
  const terms = kb.vocabulary(query || undefined).filter((term) => term.kind !== "member").slice(0, 80);
  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <label className="block text-sm font-medium" htmlFor="vocab-search">
        BOM and ruleset parameters
      </label>
      <input
        id="vocab-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="borrower, repayment, message"
        className="mt-2 h-11 w-full max-w-md rounded-control border border-line bg-bg px-3 text-sm"
      />
      <ul className="mt-4 divide-y divide-line">
        {terms.map((term) => (
          <li key={term.id} className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr]">
            <span className="text-xs font-medium text-muted">{term.kind}</span>
            <span>
              <span className="block text-sm font-medium">{term.example}</span>
              <span className="block font-mono text-xs text-faint">
                {term.className}
                {term.member ? `.${term.member}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Impact({ kb, seed, onSeed }: { kb: KnowledgeBase; seed: string; onSeed: (value: string) => void }) {
  const result = kb.impact(seed);
  const choices = [
    ...kb.artifacts.filter((item) => item.type === "package").map((item) => item.name),
    ...kb.artifacts.filter((item) => item.type === "actionRule" || item.type === "decisionTable").map((item) => item.name),
  ];
  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <label className="block text-sm font-medium" htmlFor="impact-seed">
        What else is affected?
      </label>
      <select
        id="impact-seed"
        value={seed}
        onChange={(event) => onSeed(event.target.value)}
        className="mt-2 h-11 w-full max-w-md rounded-control border border-line bg-bg px-3 text-sm"
      >
        {choices.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <ul className="mt-4 space-y-3">
        {result.artifacts.map((artifact) => (
          <li key={artifact.id} className="rounded-control border border-line px-3 py-3">
            <p className="text-sm font-medium">
              {artifact.name} <span className="font-normal text-muted">{artifact.type}</span>
            </p>
            <p className="text-sm text-muted">{result.reasons.find((reason) => reason.id === artifact.id)?.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Agent({
  requirement,
  onRequirement,
  grounding,
  onRun,
  onAccept,
  onReject,
}: {
  requirement: string;
  onRequirement: (value: string) => void;
  grounding: Grounding | null;
  onRun: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="text-lg font-medium">Requirement</h2>
        <p className="mt-1 text-sm text-muted">The chat asks this. The pipeline answers with tools, not a guess.</p>
        <div className="mt-3 flex flex-col gap-2">
          {PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onRequirement(prompt)}
              className="rounded-control border border-line px-3 py-3 text-left text-sm"
            >
              {prompt}
            </button>
          ))}
        </div>
        <textarea
          value={requirement}
          onChange={(event) => onRequirement(event.target.value)}
          rows={4}
          className="mt-3 w-full rounded-control border border-line bg-bg p-3 text-sm"
        />
        <button type="button" onClick={onRun} className="mt-3 h-11 rounded-control bg-accent px-4 text-sm font-medium text-accent-fg">
          Ground and retrieve
        </button>
      </section>
      <section className="rounded-card border border-line bg-surface p-5">
        {!grounding ? <p className="text-sm text-muted">Run a requirement to see the tool trace.</p> : null}
        {grounding ? (
          <div>
            <p className={grounding.accepted ? "text-sm font-medium text-ok" : "text-sm font-medium text-bad"}>
              {grounding.accepted ? "Proposal allowed" : "Proposal rejected"}
            </p>
            {grounding.rejection ? <p className="mt-2 text-sm">{grounding.rejection}</p> : null}
            <ol className="mt-4 space-y-3">
              {grounding.tools.map((tool, index) => (
                <li key={tool.name}>
                  <p className="font-mono text-xs text-muted">
                    {index + 1}. {tool.name}
                  </p>
                  <p className="text-sm">{tool.detail}</p>
                </li>
              ))}
            </ol>
            {grounding.draft ? (
              <pre className="mt-4 overflow-auto rounded-control bg-bg p-4 font-mono text-xs whitespace-pre-wrap">{grounding.draft}</pre>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={onAccept} className="h-10 rounded-control bg-accent px-3 text-sm font-medium text-accent-fg">
                Accept into glossary
              </button>
              <button type="button" onClick={onReject} className="h-10 rounded-control border border-line px-3 text-sm">
                Reject
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Versions({
  versions,
  drift,
  onSave,
  onCompare,
}: {
  versions: SnapshotVersion[];
  drift: DriftReport | null;
  onSave: () => void;
  onCompare: (version: SnapshotVersion) => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-card border border-line bg-surface p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Indexed versions</h2>
          <button type="button" onClick={onSave} className="h-10 rounded-control bg-accent px-3 text-sm font-medium text-accent-fg">
            Save current
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">Each save is a re-index checkpoint. Compare it to the index in memory.</p>
        <ul className="mt-4 space-y-3">
          {versions.length === 0 ? <li className="text-sm text-muted">No saved versions yet.</li> : null}
          {versions.map((version) => (
            <li key={version.id} className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-3">
              <span>
                <span className="block text-sm font-medium">{version.label}</span>
                <span className="block text-xs text-muted">
                  {version.artifactCount} artifacts · {version.termCount} terms · {version.savedAt.slice(0, 16).replace("T", " ")}
                </span>
              </span>
              <button type="button" onClick={() => onCompare(version)} className="h-9 rounded-control border border-line px-3 text-sm">
                Drift
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="text-lg font-medium">Drift</h2>
        {!drift ? <p className="mt-2 text-sm text-muted">Compare a saved version to see added, removed, and changed artifacts.</p> : null}
        {drift ? (
          <ul className="mt-4 space-y-2 text-sm">
            <li>Added {drift.added.length}</li>
            <li>Removed {drift.removed.length}</li>
            <li>Changed {drift.changed.length}</li>
            <li>Vocabulary added {drift.vocabularyAdded.length}</li>
            <li>Vocabulary removed {drift.vocabularyRemoved.length}</li>
          </ul>
        ) : null}
      </section>
    </div>
  );
}

const VERSION_KEY = "rulebase.versions";
const SNAPSHOT_KEY = "rulebase.snapshots";

function readStoredSnapshots(): Record<string, KnowledgeSnapshot> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY) || "{}") as Record<string, KnowledgeSnapshot>;
  } catch {
    return {};
  }
}

function writeStoredSnapshots(value: Record<string, KnowledgeSnapshot>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(value));
}

function countTypes(kb: KnowledgeBase): { label: string; count: number }[] {
  const tally = (type: Artifact["type"], label: string) => ({
    label,
    count: kb.artifacts.filter((item) => item.type === type).length,
  });
  return [
    tally("actionRule", "Action rules"),
    tally("decisionTable", "Decision tables"),
    tally("ruleflow", "Ruleflows"),
    tally("package", "Packages"),
    { label: "Vocabulary terms", count: kb.terms.length },
    { label: "Graph links", count: kb.edges.length },
  ];
}
