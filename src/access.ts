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
  pi.on("tool_call", (event, ctx) => {
    const pathTools: Record<string, true> = { read: true, grep: true, glob: true, write: true };
    if (Object.hasOwn(pathTools, event.toolName)) {
      const raw = "path" in event.input && typeof event.input.path === "string" ? event.input.path : ".";
      try {
        access.assertPath(raw, ctx.cwd, event.toolName === "write", event.toolName === "glob" || event.toolName === "grep");
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (event.toolName === "edit") {
      const patch = Object.values(event.input).filter(value => typeof value === "string").join("\n");
      const targets = [...patch.matchAll(/^\[([^#\r\n]+)#[A-F0-9]{4}\]/gm)];
      try {
        for (const target of targets) access.assertPath(target[1]!, ctx.cwd, true);
        if (targets.length === 0) return { block: true, reason: "Lesson edits require explicit file targets inside learning/" };
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (["recall", "reflect", "memory_edit"].includes(event.toolName)) {
      return { block: true, reason: "Use shared learning logs, not unrelated memory, to assess this learner" };
    }
  });
  pi.on("before_agent_start", event => ({
    systemPrompt: [...event.systemPrompt, `Learning workspace access policy: automatically read content only within ${config.learningDir}. Do not traverse or search any other Org-roam directory. External files explicitly authorized by the user this session: ${JSON.stringify([...access.files])}. They are read-only source material, not evidence of learner knowledge. The configured Anki file is export-only; never inspect existing cards. Package implementation/skills and current-session research artifacts are available as infrastructure, not personal knowledge context. Do not bypass this policy with shell, eval, browser, subagents, symlinks, or other tools. Perform coding exercises within the learning directory. Teacher prose in logs is reference material; only learner attempts are evidence of demonstrated understanding.`],
  }));
  return access;
}
