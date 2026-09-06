import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import quiz from "../extensions/quiz";
import visualTools from "../extensions/visual-tools/index";
import { expandPath, loadConfig } from "./config";
import { registerAccess } from "./access";
import { registerNotebook } from "./notebook";
import { registerInteractive } from "./interactive";
import { registerInteractiveChild } from "./interactive-child";
import { registerStudy } from "./study";

export default function learning(pi: ExtensionAPI): void {
  pi.registerCommand("lesson-setup", {
    description: "Create an OMP learning workspace with optional existing Anki export",
    handler: async (_args, ctx) => {
      const directory = await ctx.ui.input("Shared learning directory", "~/org/roam/learning");
      if (!directory?.trim()) return;
      const root = expandPath(directory.trim(), ctx.cwd);
      const file = join(root, ".omp", "learn.json");
      if (existsSync(file)) {
        ctx.ui.notify(`Configuration already exists: ${file}. Edit it explicitly rather than overwrite it.`, "warning");
        return;
      }
      const anki = await ctx.ui.input("Existing Anki Org file (blank disables export)", "~/org/anki.org");
      if (anki === undefined) return;
      const deck = anki.trim() ? await ctx.ui.input("Anki deck", "Default") : "Default";
      if (deck === undefined) return;
      mkdirSync(join(root, ".omp"), { recursive: true });
      writeFileSync(file, JSON.stringify({ learningDir: root, ...(anki.trim() ? { ankiFile: expandPath(anki.trim(), ctx.cwd) } : {}), ankiHeading: "Dispatch Shelf", ankiDeck: deck.trim() || "Default" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      ctx.ui.notify(`Workspace configured. Start OMP in ${root}, then use /lesson <goal>.`, "info");
    },
  });

  const config = loadConfig(process.cwd());
  if (!config) {
    pi.registerCommand("lesson", {
      description: "Start a lesson (run /lesson-setup first)",
      handler: async (_args, ctx) => ctx.ui.notify("Run /lesson-setup, then restart OMP in the configured learning directory.", "warning"),
    });
    pi.registerCommand("study", {
      description: "Read a document together (run /lesson-setup first)",
      handler: async (_args, ctx) => ctx.ui.notify("Run /lesson-setup, then restart OMP in the configured learning directory.", "warning"),
    });
    return;
  }

  const child = Boolean(process.env.OMP_LEARN_CHILD);
  registerAccess(pi, config);
  const notebook = registerNotebook(pi, config);
  quiz(pi);
  visualTools(pi, config);
  if (child) registerInteractiveChild(pi, config);
  else registerInteractive(pi, config);
  // Craft is shared; exactly one process file is in force. Injecting both processes
  // would leave the model to arbitrate two contradictory session shapes by instruction.
  const prompt = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const craft = prompt("prompts/craft.md");
  const lesson = prompt("skills/teach/SKILL.md");
  const study = prompt("skills/study/SKILL.md");
  const reading = registerStudy(pi, config, notebook);

  pi.registerCommand("lesson", {
    description: "Open the rendered Org log and begin or continue teaching toward a goal",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /lesson <what you want to understand or be able to do>", "warning");
        return;
      }
      try {
        await notebook.start(goal, ctx);
        pi.sendUserMessage(goal);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.on("before_agent_start", event => {
    if (!notebook.getLogFile()) return;
    return { systemPrompt: [...event.systemPrompt, craft, reading.active() ? study : lesson] };
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "quiz" && !notebook.getLogFile()) {
      return { block: true, reason: "Start a logged lesson with /lesson <goal> before asking a quiz" };
    }
    if ((event.toolName === "render_svg" || event.toolName === "render_mermaid") && ctx.model && !ctx.model.input.includes("image")) {
      return { block: true, reason: "Diagram verification requires a vision-capable model. Select one before rendering." };
    }
  });
}
