import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Session } from "../src/session.ts";
import { copyTree, MINILOAN, tempDir } from "./helpers.ts";

test("incremental reindex reuses unchanged files, identical reindex stores nothing", () => {
  const dir = tempDir();
  const workspace = path.join(dir, "ws");
  copyTree(MINILOAN, workspace);
  const cacheFile = path.join(dir, "cache.sqlite");
  const first = new Session(workspace, { cacheFile });
  const a = first.rebuild();
  assert.equal(a.stats.reused, 0);
  first.close();
  const sizeAfterFirst = fs.statSync(cacheFile).size;

  const second = new Session(workspace, { cacheFile });
  const b = second.rebuild();
  assert.equal(b.stats.parsed, 0, "warm start reuses every parse from the cache");
  assert.equal(b.kb.meta.contentHash, a.kb.meta.contentHash);
  second.rebuild();
  second.rebuild();
  second.close();
  // WAL may hold pages; the main file must not grow for identical reindexes.
  assert.ok(fs.statSync(cacheFile).size <= sizeAfterFirst * 1.5);

  const rule = path.join(workspace, "rules", "validation", "maximum amount.brl");
  fs.writeFileSync(
    rule,
    fs.readFileSync(rule, "utf8").replace("more than 1,000,000", "more than 500,000"),
  );
  const third = new Session(workspace, { cacheFile });
  const c = third.rebuild();
  assert.equal(c.stats.parsed, 1, "only the edited file is parsed again");
  const drift = third.drift();
  assert.deepEqual(
    drift.changed.map((item) => item.name),
    ["maximum amount"],
  );
  assert.deepEqual(drift.added, []);
  third.close();
});

test("only the current and previous snapshots are kept", () => {
  const dir = tempDir();
  const workspace = path.join(dir, "ws");
  copyTree(MINILOAN, workspace);
  const cacheFile = path.join(dir, "cache.sqlite");
  const session = new Session(workspace, { cacheFile });
  const rule = path.join(workspace, "rules", "validation", "maximum amount.brl");
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(
      rule,
      fs.readFileSync(rule, "utf8").replace(/is more than [\d,]+/, `is more than ${100000 + i}`),
    );
    session.rebuild();
  }
  const latest = session.store.latest()!;
  const previous = session.store.previous()!;
  assert.ok(latest.id > previous.id);
  // @ts-expect-error reaching into the private handle for a count
  const count = session.store.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as {
    n: number;
  };
  assert.equal(count.n, 2);
  session.close();
});

test("a session notices a changed file before answering", async () => {
  const dir = tempDir();
  const workspace = path.join(dir, "ws");
  copyTree(MINILOAN, workspace);
  const session = new Session(workspace, { cacheFile: path.join(dir, "c.sqlite"), watch: true });
  assert.equal(session.kb().findArtifact("maximum amount").artifact?.name, "maximum amount");
  const rule = path.join(workspace, "rules", "validation", "maximum amount.brl");
  fs.writeFileSync(
    rule,
    fs
      .readFileSync(rule, "utf8")
      .replace("<name>maximum amount</name>", "<name>maximum loan amount</name>"),
  );
  for (
    let i = 0;
    i < 50 && session.kb().findArtifact("maximum loan amount").artifact === undefined;
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    session.kb().findArtifact("maximum loan amount").artifact?.name,
    "maximum loan amount",
  );
  session.close();
});
