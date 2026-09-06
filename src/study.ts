import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { canonicalPath, inside } from "./access";
import { expandPath, type LearnConfig } from "./config";

// ────────────────────────────────────────────────────────────────────────────
// /study — reading one document with the learner.
//
// A lesson is agent-led; a study session is document-led. The command's whole
// job is to make the document permanently readable, give the session a resume
// contract, and hand both to the teacher. Everything pedagogical lives in
// skills/study/SKILL.md.
//
// The source is COPIED into the learning directory rather than granted with
// /lesson-context, for three reasons: the snapshot survives a URL that changes
// or a file that moves, a later session resumes without re-granting anything,
// and researcher children — which restore their own access state and therefore
// inherit no explicit grants — can read the segments they are asked to brief.
// ────────────────────────────────────────────────────────────────────────────

const STATE = "omp-learn-org.study";
const StudyState = z.strictObject({ meta: z.string().nullable() });

const Segment = z.object({ n: z.number().int().positive(), title: z.string(), locator: z.string().optional() });
const Gap = z.object({ item: z.string(), status: z.enum(["open", "closed"]), note: z.string().optional() });

/** The resume contract. The teacher rewrites this file; the command only seeds it. */
export const StudyMeta = z.object({
  source: z.string(),
  kind: z.enum(["url", "file"]),
  slug: z.string(),
  log: z.string(),
  snapshot: z.string(),
  goal: z.string().optional(),
  mode: z.enum(["orient", "working", "mastery"]).optional(),
  segments: z.array(Segment).default([]),
  cursor: z.number().int().nonnegative().default(0),
  gaps: z.array(Gap).default([]),
});
export type StudyMeta = z.infer<typeof StudyMeta>;

export type Source = { source: string; kind: "url" | "file" };

export function resolveSource(raw: string, cwd: string): Source {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return { source: new URL(value).toString(), kind: "url" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("A study source is an http(s) URL or a local file");
  const path = canonicalPath(expandPath(value, cwd));
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Not a readable file: ${path}`);
  return { source: path, kind: "file" };
}

function urlLabel(source: string): string {
  const url = new URL(source);
  const raw = url.pathname.split("/").filter(Boolean).pop() ?? "";
  // A percent-escape would otherwise slugify into digits: "TLS%201.3" → "tls-201-3".
  let tail: string;
  try {
    tail = decodeURIComponent(raw);
  } catch {
    tail = raw;
  }
  return [url.hostname.replace(/^www\./, ""), tail.replace(/\.[a-z0-9]{1,5}$/i, "")].filter(Boolean).join("-");
}

export function sourceSlug({ source, kind }: Source): string {
  const label = kind === "url" ? urlLabel(source) : basename(source, extname(source));
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "document";
}

/**
 * One state file per document. Two documents whose names slugify the same must
 * not share a cursor or a log, so a collision against a different source falls
 * back to a source-derived suffix instead of adopting the existing session.
 */
export function metaFile(config: LearnConfig, source: Source): string {
  const dir = join(config.learningDir, ".study");
  const file = join(dir, `${sourceSlug(source)}.json`);
  if (!existsSync(file)) return file;
  if (readMeta(file).source === source.source) return file;
  return join(dir, `${sourceSlug(source)}-${createHash("sha256").update(source.source).digest("hex").slice(0, 6)}.json`);
}

export function readMeta(file: string): StudyMeta {
  return StudyMeta.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** URL text is written by the teacher after extraction; a local file is copied here and now. */
function snapshot(config: LearnConfig, source: Source, slug: string): string {
  if (source.kind === "url") return join(config.learningDir, "sources", `${slug}.md`);
  if (inside(config.learningDir, source.source)) return source.source;
  const file = join(config.learningDir, "sources", `${slug}${extname(source.source)}`);
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(source.source, file);
  return file;
}

export function ankiTag(slug: string): string {
  return `study_${slug.replace(/[^a-z0-9]+/gi, "_")}`.slice(0, 48);
}

/** The first turn's user message: it seeds the teacher's context and lands in the Org log verbatim. */
export function kickoff(meta: StudyMeta, file: string, resuming: boolean): string {
  if (!resuming) {
    return [
      `Study session. Source: ${meta.source}`,
      `Snapshot: ${meta.snapshot}${meta.kind === "url" ? " — extract the page text and write it there first." : ""}`,
      `State file: ${file} — keep the segment map, cursor, goal, mode and gap ledger current in it.`,
      "Start at Phase A of the study skill. Nothing about this document's own content gets graded before I have read it.",
    ].join("\n");
  }
  return [
    `Resuming study of ${meta.source}.`,
    `State file: ${file} — read it and the log before saying anything.`,
    `It says I finished ${meta.cursor} of ${meta.segments.length || "?"} segments, with ${meta.gaps.filter(gap => gap.status === "open").length} gap(s) still open.`,
    "Confirm where we stand in a sentence or two, then continue the read-along.",
  ].join("\n");
}

interface Notebook {
  getLogFile: () => string | undefined;
  start: (title: string, ctx: never) => Promise<string>;
  link: (file: string, ctx: never) => Promise<void>;
  setTag: (tag: string | undefined) => void;
}

/**
 * The state file whose log is `log`, if any. `/study` records its own state on the
 * session, but `/org-log` on a study log does not, and a document read must not
 * silently fall back to the lesson process just because it was reopened that way.
 */
export function studyFor(config: LearnConfig, log: string): StudyMeta | undefined {
  const dir = join(config.learningDir, ".study");
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const meta = readMeta(join(dir, entry));
    if (meta.log === log) return meta;
  }
  return undefined;
}

export function registerStudy(pi: ExtensionAPI, config: LearnConfig, notebook: Notebook) {
  let active: string | undefined;

  function restore(ctx: ExtensionContext): void {
    active = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE) active = StudyState.parse(entry.data).meta ?? undefined;
    }
    notebook.setTag(active && existsSync(active) ? ankiTag(readMeta(active).slug) : undefined);
  }

  function reading(): StudyMeta | undefined {
    const log = notebook.getLogFile();
    if (!log) return undefined;
    if (active && existsSync(active)) {
      const meta = readMeta(active);
      if (meta.log === log) return meta;
    }
    return studyFor(config, log);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_switch", (_event, ctx) => restore(ctx));
  pi.on("session_branch", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerCommand("study", {
    description: "Read a document together: orientation, prerequisite probe, primer, then a guided read",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /study <file or https://…>", "warning");
        return;
      }
      try {
        const source = resolveSource(args, ctx.cwd);
        const file = metaFile(config, source);
        const resuming = existsSync(file);
        const open = notebook.getLogFile();
        let meta: StudyMeta;
        if (resuming) {
          meta = readMeta(file);
          if (open && open !== meta.log) throw new Error("Another learning log is active. Run /org-unlog first.");
          if (!open) await notebook.link(meta.log, ctx as never);
        } else {
          if (open) throw new Error("Another learning log is active. Run /org-unlog first.");
          const slug = basename(file, ".json");
          const stored = snapshot(config, source, slug);
          // The Org #+title reads better as the document's own name than as its slug.
          const name = source.kind === "url" ? source.source : basename(source.source, extname(source.source));
          const log = await notebook.start(`Study: ${name}`, ctx as never);
          meta = { ...source, slug, log, snapshot: stored, segments: [], cursor: 0, gaps: [] };
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify(meta, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        }
        active = file;
        pi.appendEntry(STATE, { meta: file });
        notebook.setTag(ankiTag(meta.slug));
        pi.sendUserMessage(kickoff(meta, file, resuming));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  return {
    active: () => {
      const meta = reading();
      // A log reopened with /org-log carries no session state; adopt its tag on the way past.
      if (meta) notebook.setTag(ankiTag(meta.slug));
      return Boolean(meta);
    },
  };
}
