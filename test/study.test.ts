import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearnConfig } from "../src/config";
import { ankiTag, kickoff, metaFile, resolveSource, sourceSlug, StudyMeta } from "../src/study";

let root: string;
let learning: string;
let config: LearnConfig;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-learn-study-")));
  learning = join(root, "learning");
  mkdirSync(join(learning, ".study"), { recursive: true });
  config = { learningDir: learning, ankiDeck: "Default", ankiHeading: "Dispatch Shelf", emacsclient: "emacsclient", pandoc: "pandoc" };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(file: string, source: string): void {
  writeFileSync(file, JSON.stringify({ source, kind: "file", slug: "paper", log: join(learning, "a.org"), snapshot: join(learning, "sources", "paper.pdf") }));
}

test("a source resolves to a URL or an existing local file, and nothing else", () => {
  expect(resolveSource(" https://example.com/a/paper.pdf ", root)).toEqual({ source: "https://example.com/a/paper.pdf", kind: "url" });
  writeFileSync(join(root, "paper.pdf"), "%PDF");
  expect(resolveSource("paper.pdf", root)).toEqual({ source: join(root, "paper.pdf"), kind: "file" });
  expect(() => resolveSource("ftp://example.com/paper.pdf", root)).toThrow(Error);
  expect(() => resolveSource("missing.pdf", root)).toThrow(Error);
  expect(() => resolveSource(root, root)).toThrow(Error);
});

test("slugs stay filesystem-safe and survive a URL with no useful tail", () => {
  expect(sourceSlug({ source: "https://www.example.com/papers/TLS 1.3!.pdf", kind: "url" })).toBe("example-com-tls-1-3");
  expect(sourceSlug({ source: "https://example.com/", kind: "url" })).toBe("example-com");
  expect(sourceSlug({ source: "/tmp/Attention Is All You Need.pdf", kind: "file" })).toBe("attention-is-all-you-need");
  expect(ankiTag("attention-is-all-you-need")).toBe("study_attention_is_all_you_need");
});

test("the same document reuses its state file and a colliding name gets its own", () => {
  const first = metaFile(config, { source: "/tmp/a/paper.pdf", kind: "file" });
  expect(first).toBe(join(learning, ".study", "paper.json"));
  seed(first, "/tmp/a/paper.pdf");
  expect(metaFile(config, { source: "/tmp/a/paper.pdf", kind: "file" })).toBe(first);
  const other = metaFile(config, { source: "/tmp/b/paper.pdf", kind: "file" });
  expect(other).not.toBe(first);
  expect(other.startsWith(join(learning, ".study", "paper-"))).toBe(true);
});

test("the resume message reports the cursor and the open gaps only", () => {
  const meta = StudyMeta.parse({
    source: "/tmp/paper.pdf", kind: "file", slug: "paper", log: join(learning, "a.org"), snapshot: join(learning, "sources", "paper.pdf"),
    segments: [{ n: 1, title: "One" }, { n: 2, title: "Two" }], cursor: 1,
    gaps: [{ item: "Galois fields", status: "open" }, { item: "modular arithmetic", status: "closed" }],
  });
  const resumed = kickoff(meta, "/state.json", true);
  expect(resumed).toContain("finished 1 of 2 segments, with 1 gap(s) still open");
  expect(kickoff(meta, "/state.json", false)).toContain("Phase A");
});

test("a URL snapshot is announced as work the teacher still has to do", () => {
  const url = StudyMeta.parse({ source: "https://example.com/a", kind: "url", slug: "a", log: join(learning, "a.org"), snapshot: join(learning, "sources", "a.md") });
  expect(kickoff(url, "/state.json", false)).toContain("extract the page text");
  const file = StudyMeta.parse({ ...url, kind: "file", source: "/tmp/a.pdf", snapshot: join(learning, "sources", "a.pdf") });
  expect(kickoff(file, "/state.json", false)).not.toContain("extract the page text");
});
