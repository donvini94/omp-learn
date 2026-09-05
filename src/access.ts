import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { expandPath, type LearnConfig } from "./config";

const CONTEXT_STATE = "omp-learn-org.context";
const ContextState = z.strictObject({ files: z.array(z.string()) });
const PACKAGE_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

export function canonicalPath(path: string): string {
  let ancestor = path;
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve path ${path}`);
    suffix.unshift(ancestor.slice(parent.length).replace(/^[/\\]+/, ""));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export class ContextAccess {
  readonly files = new Set<string>();
  constructor(readonly config: LearnConfig) {}

  permit(file: string, cwd: string): string {
    const resolved = realpathSync(expandPath(file, cwd));
    if (this.config.ankiFile && resolved === canonicalPath(this.config.ankiFile)) throw new Error("The Anki destination is export-only");
    if (!statSync(resolved).isFile()) throw new Error("Provide one file, not a directory, as lesson context");
    this.files.add(resolved);
    return resolved;
  }

  assertPath(raw: string, cwd: string, write = false, pattern = false): void {
    for (const item of (raw.trim() || ".").split(";").map(value => value.trim()).filter(Boolean)) {
      if (/^(https?:|skill:|omp:|artifact:|agent:|local:)/i.test(item)) {
        if (write) throw new Error("Lesson writes must target a file inside the learning directory");
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item) && !item.startsWith("file://")) {
        throw new Error("This context scheme is not part of the learning workspace");
      }
      let path = item.startsWith("file://") ? fileURLToPath(item) : decodeURIComponent(item);
      if (pattern) {
        if (/(?:^|[/\\,{])\.\.(?:[/\\,}]|$)/.test(path)) throw new Error("Resolve parent-directory segments before searching");
        const wildcard = path.search(/[\*?{\[]/);
        if (wildcard >= 0) path = path.slice(0, wildcard).replace(/[^/\\]*$/, "") || ".";
      } else {
        path = path.split("?", 1)[0]!;
        // OMP selectors follow the filename. Existing literal-colon filenames win.
        while (!existsSync(expandPath(path, cwd)) && /:[^/\\]*$/.test(path)) path = path.replace(/:[^/\\]*$/, "");
      }
      while (!existsSync(expandPath(path, cwd)) && /:[^/\\]*$/.test(path)) path = path.replace(/:[^/\\]*$/, "");
      const resolved = canonicalPath(expandPath(path, cwd));
      if (this.config.ankiFile && inside(resolved, canonicalPath(this.config.ankiFile))) throw new Error("The Anki destination is export-only");
      if (inside(this.config.learningDir, resolved)) continue;
      if (!write && (inside(PACKAGE_ROOT, resolved) || this.files.has(resolved))) continue;
      throw new Error(`Outside the shared learning directory. The user must explicitly provide this file with /lesson-context: ${path}`);
    }
  }
}

const MEMORY_REASON = "Use shared learning logs, not unrelated memory, to assess this learner";
/** Tools that would let the teacher assess the learner from memory outside the shared logs. */
const MEMORY_TOOLS = new Set(["recall", "reflect", "memory_edit"]);
/** Path-taking tools whose target must sit inside the learning workspace. */
const PATH_TOOLS = new Set(["read", "grep", "glob", "write"]);
/** `xd://<tool>` is OMP's device transport: `read` fetches docs, `write` executes. */
const DEVICE = /^\s*xd:\/\/([a-z0-9_.-]*)/i;

export type ToolVerdict = { block: true; reason: string } | undefined;

function deny(error: unknown): ToolVerdict {
  return { block: true, reason: error instanceof Error ? error.message : String(error) };
}

/**
 * Decide one tool call against the workspace policy. Device dispatches are
 * resolved to the tool they actually run: blocking the `xd://` URL itself would
 * take out every mounted tool, `quiz` included, while letting a device-routed
 * `recall` or `ast_edit` slip past the checks their top-level forms get.
 */
export function evaluateToolCall(
  access: ContextAccess,
  toolName: string,
  input: object,
  cwd: string,
): ToolVerdict {
  const args = input as Record<string, unknown>;
  const rawPath = typeof args.path === "string" ? args.path : undefined;
  const device = toolName === "read" || toolName === "write" ? DEVICE.exec(rawPath ?? "") : null;
  if (device) {
    const inner = device[1]!.toLowerCase();
    if (MEMORY_TOOLS.has(inner)) return deny(new Error(MEMORY_REASON));
    // ast_edit rewrites files in place; hold its targets to the write policy.
    if (inner === "ast_edit" && toolName === "write" && typeof args.content === "string") {
      let paths: unknown;
      try {
        paths = (JSON.parse(args.content) as { paths?: unknown }).paths;
      } catch {
        return undefined; // Malformed args never reach a file; the device reports the schema error.
      }
      if (!Array.isArray(paths)) return undefined;
      try {
        for (const path of paths) if (typeof path === "string") access.assertPath(path, cwd, true, true);
      } catch (error) {
        return deny(error);
      }
    }
    return undefined;
  }
  if (PATH_TOOLS.has(toolName)) {
    try {
      access.assertPath(rawPath ?? ".", cwd, toolName === "write", toolName === "glob" || toolName === "grep");
    } catch (error) {
      return deny(error);
    }
  }
  if (toolName === "edit") {
    const patch = Object.values(input).filter(value => typeof value === "string").join("\n");
    const targets = [...patch.matchAll(/^\[([^#\r\n]+)#[A-F0-9]{4}\]/gm)];
    if (targets.length === 0) return { block: true, reason: "Lesson edits require explicit file targets inside learning/" };
    try {
      for (const target of targets) access.assertPath(target[1]!, cwd, true);
    } catch (error) {
      return deny(error);
    }
  }
  if (MEMORY_TOOLS.has(toolName)) return { block: true, reason: MEMORY_REASON };
  return undefined;
}

export function registerAccess(pi: ExtensionAPI, config: LearnConfig): ContextAccess {
  const access = new ContextAccess(config);
  function restore(ctx: ExtensionContext): void {
    access.files.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CONTEXT_STATE) {
        const state = ContextState.parse(entry.data);
        access.files.clear();
        for (const file of state.files) access.files.add(file);
      }
    }
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_switch", (_event, ctx) => restore(ctx));
  pi.on("session_branch", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.registerCommand("lesson-context", {
    description: "Explicitly provide one external context file; never grants a directory",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /lesson-context /absolute/path/to/file", "warning");
        return;
      }
      try {
        const file = access.permit(args.trim(), ctx.cwd);
        pi.appendEntry(CONTEXT_STATE, { files: [...access.files] });
        ctx.ui.notify(`Context file authorized: ${file}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.on("tool_call", (event, ctx) => evaluateToolCall(access, event.toolName, event.input, ctx.cwd));
  pi.on("before_agent_start", event => ({
    systemPrompt: [...event.systemPrompt, `Learning workspace access policy: automatically read content only within ${config.learningDir}. Do not traverse or search any other Org-roam directory. External files explicitly authorized by the user this session: ${JSON.stringify([...access.files])}. They are read-only source material, not evidence of learner knowledge. The configured Anki file is export-only; never inspect existing cards. Package implementation/skills and current-session research artifacts are available as infrastructure, not personal knowledge context. Do not bypass this policy with shell, eval, browser, subagents, symlinks, or other tools. Perform coding exercises within the learning directory. Teacher prose in logs is reference material; only learner attempts are evidence of demonstrated understanding.`],
  }));
  return access;
}
