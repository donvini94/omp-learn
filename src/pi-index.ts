import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TUI, Editor, Key, Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import quiz from "../extensions/quiz";
import visualTools from "../extensions/visual-tools/index";
import { ContextAccess, evaluateToolCall } from "./access";
import { expandPath, loadPiConfig } from "./config";
import type { HarnessApi } from "./harness";
import { registerNotebook } from "./notebook";

import { registerStudy } from "./study";

const SUBAGENT_STATE = "omp-learn-org.pi-subagents";

const CONTEXT_STATE = "omp-learn-org.context";

function piEditorTheme(theme: { fg(color: string, text: string): string }) {
  return {
    borderColor: (text: string) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    },
  };
}

function learningPolicy(config: { learningDir: string }, files: Iterable<string>): string {
  return `Learning workspace access policy: automatically read content only within ${config.learningDir}. Do not traverse or search any other Org-roam directory. External files explicitly authorized by the user this session: ${JSON.stringify([...files])}. They are read-only source material, not evidence of learner knowledge. The configured Anki file is export-only; never inspect existing cards. Package implementation/skills and current-session research artifacts are available as infrastructure, not personal knowledge context. Do not bypass this policy with shell, eval, browser, subagents, symlinks, or other tools. Perform coding exercises within the learning directory. Teacher prose in logs is reference material; only the learner's own words and answers are evidence of their knowledge.`;
}

function syncPiResearcher(config: { learningDir: string }): void {
  const source = fileURLToPath(new URL("../pi/agents/researcher.md", import.meta.url));
  const directory = join(config.learningDir, ".pi", "agents");
  const destination = join(directory, "researcher.md");
  const previous = existsSync(destination) ? readFileSync(destination, "utf8") : undefined;
  if (previous && !previous.includes("pi-adapter: omp-learn")) return;
  const output = readFileSync(source, "utf8");
  if (previous === output) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(destination, output, { mode: 0o600 });
}

function piToolVerdict(
  access: ContextAccess,
  config: { learningDir: string },
  childSessions: ReadonlySet<string>,
  toolName: string,
  input: object,
  cwd: string,
): { block: true; reason: string } | undefined {
  if (toolName === "bash") return { block: true, reason: "Learning sessions do not run unrestricted shell commands; use the confined file tools or purpose-built learning tools." };
  if (toolName === "find" || toolName === "ls") {
    const path = "path" in input && typeof input.path === "string" ? input.path : ".";
    try {
      access.assertPath(path, cwd, false, toolName === "find");
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    return undefined;
  }
  if (toolName === "subagent") {
    if ("backend" in input || "cli" in input || "resumeSessionId" in input) return { block: true, reason: "Learning subagents use the Pi backend and do not accept backend or resumed-session overrides." };
    if ("cwd" in input && input.cwd !== undefined && typeof input.cwd !== "string") return { block: true, reason: "Subagent cwd must be a path." };
    if ("agent" in input && input.agent !== undefined && input.agent !== "researcher" && input.agent !== "mermaid-maker" && input.agent !== "svg-maker") return { block: true, reason: "Learning subagents must use a confined personal learning agent." };
    Object.assign(input, { cwd: config.learningDir });
    return undefined;
  }
  if (toolName === "subagent_resume") {
    const sessionPath = "sessionPath" in input && typeof input.sessionPath === "string" ? input.sessionPath : undefined;
    if (!sessionPath || !childSessions.has(sessionPath)) return { block: true, reason: "Only a child session spawned by this active lesson may be resumed." };
    return undefined; // The resumed child recovers this workspace from its session header (see loadPiConfig).
  }
  if (toolName === "edit") {
    const path = "path" in input && typeof input.path === "string" ? input.path : undefined;
    try {
      access.assertPath(path ?? ".", cwd, true);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    return undefined;
  }
  return evaluateToolCall(access, toolName, input, cwd);
}

export default function piLearning(pi: ExtensionAPI): void {
  pi.registerCommand("lesson-setup", {
    description: "Create a Pi learning workspace with optional existing Anki export",
    handler: async (_args, ctx) => {
      const directory = await ctx.ui.input("Shared learning directory", "~/org/roam/learning");
      if (!directory?.trim()) return;
      const root = expandPath(directory.trim(), ctx.cwd);
      const file = join(root, ".pi", "learn.json");
      if (existsSync(file)) {
        ctx.ui.notify(`Configuration already exists: ${file}. Edit it explicitly rather than overwrite it.`, "warning");
        return;
      }
      const anki = await ctx.ui.input("Existing Anki Org file (blank disables export)", "~/org/anki.org");
      if (anki === undefined) return;
      const deck = anki.trim() ? await ctx.ui.input("Anki deck", "Default") : "Default";
      if (deck === undefined) return;
      mkdirSync(join(root, ".pi"), { recursive: true });
      writeFileSync(file, JSON.stringify({ learningDir: root, ...(anki.trim() ? { ankiFile: expandPath(anki.trim(), ctx.cwd) } : {}), ankiHeading: "Dispatch Shelf", ankiDeck: deck.trim() || "Default" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      ctx.ui.notify(`Workspace configured. Start Pi in ${root}, then use /lesson <goal>.`, "info");
    },
  });

  const config = loadPiConfig(process.cwd());
  if (!config) {
    for (const [name, description] of [["lesson", "Start a lesson"], ["study", "Read a document together"]] as const) {
      pi.registerCommand(name, { description: `${description} (run /lesson-setup first)`, handler: async (_args, ctx) => ctx.ui.notify("Run /lesson-setup, then restart Pi in the configured learning directory.", "warning") });
    }
    return;
  }

  const access = new ContextAccess(config);
  const restoreAccess = (ctx: { sessionManager: { getBranch(): Iterable<{ type: string; customType?: string; data?: unknown }> } }) => {
    access.files.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CONTEXT_STATE && entry.data && typeof entry.data === "object" && "files" in entry.data && Array.isArray(entry.data.files)) {
        for (const file of entry.data.files) if (typeof file === "string") access.files.add(file);
      }
    }
  };
  const childSessions = new Set<string>();
  const restoreChildSessions = (ctx: { sessionManager: { getBranch(): Iterable<{ type: string; customType?: string; data?: unknown }> } }) => {
    childSessions.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_STATE || !entry.data || typeof entry.data !== "object" || !("sessions" in entry.data) || !Array.isArray(entry.data.sessions)) continue;
      for (const session of entry.data.sessions) if (typeof session === "string") childSessions.add(session);
    }
  };
  pi.on("session_start", (_event, ctx) => {
    syncPiResearcher(config);
    restoreAccess(ctx);
    restoreChildSessions(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreAccess(ctx);
    restoreChildSessions(ctx);
  });
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
  pi.on("tool_call", (event, ctx) => piToolVerdict(access, config, childSessions, event.toolName, event.input, ctx.cwd));
  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent" || !event.details || typeof event.details !== "object" || !("sessionFile" in event.details) || typeof event.details.sessionFile !== "string") return;
    childSessions.add(event.details.sessionFile);
    pi.appendEntry(SUBAGENT_STATE, { sessions: [...childSessions] });
  });
  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${learningPolicy(config, access.files)}\n\nUse Pi's \`ask_user_question\` for preferences and decisions, with one question per call. Use \`quiz\` only for graded questions. The researcher may use \`mcp__exa__web_search_exa\` and \`web_fetch\` for web evidence when available; those network tools remain allowed while local file access stays confined by this policy.` }));

  // Both harnesses implement this slice; their full ExtensionAPI types are not mutually assignable.
  const shared = pi as unknown as HarnessApi;
  const notebook = registerNotebook(shared, config, true);
  quiz(shared, {
    Key,
    Text,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi,
    makeEditor: (tui, theme) => new Editor(tui as TUI, piEditorTheme(theme)),
  });
  visualTools(shared, config);
  const reading = registerStudy(shared, config, notebook, true);
  const prompt = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const craft = prompt("prompts/craft.md");
  const lesson = prompt("skills/teach/SKILL.md");
  const study = prompt("skills/study/SKILL.md");

  pi.registerCommand("lesson", {
    description: "Open the rendered Org log and begin or continue teaching toward a goal",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /lesson <what you want to understand or be able to do>", "warning");
        return;
      }
      try {
        // The notebook only uses members both harnesses provide; their full context types differ.
        await notebook.start(goal, ctx as unknown as Parameters<typeof notebook.start>[1]);
        pi.sendUserMessage(goal);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.on("before_agent_start", (event) => {
    if (!notebook.getLogFile()) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${craft}\n\n${reading.active() ? study : lesson}` };
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "quiz" && !notebook.getLogFile()) return { block: true, reason: "Start a logged lesson with /lesson <goal> before asking a quiz" };
    if ((event.toolName === "render_svg" || event.toolName === "render_mermaid") && ctx.model && !ctx.model.input.includes("image")) return { block: true, reason: "Diagram verification requires a vision-capable model. Select one before rendering." };
  });
}
