import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { closeSurface, createSurface, getMuxBackend, pollForExit, sendEscape, sendLongCommand, shellEscape } from "pi-interactive-subagents/pi-extension/subagents/cmux.ts";
import { z } from "zod";
import { canonicalPath, inside } from "./access";
import { expandPath, type LearnConfig } from "./config";
import { SubagentResult, SubagentRun, SubagentStatus } from "./subagent-protocol";

const STATE = "omp-learn-org.subagents";
const RESULT = "omp-learn-org.subagent-result";
const packageAgents = fileURLToPath(new URL("../agents", import.meta.url));
const extensionFile = fileURLToPath(new URL("./index.ts", import.meta.url));
const text = z.string().trim().min(1);
const name = text.max(80).regex(/^[^\r\n\x00-\x1f]+$/);
const tools = z.union([z.string(), z.array(text)]).transform(value => typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : value);
const AgentMetadata = z.object({
  name: text,
  description: z.string().optional(),
  tools: tools.optional(),
  model: z.union([text, z.array(text).min(1)]).optional(),
  thinking: text.optional(),
  "thinking-level": text.optional(),
  thinkingLevel: text.optional(),
});
const Launch = z.strictObject({
  run: SubagentRun,
  directory: text,
  surface: text,
  backend: z.enum(["cmux", "tmux", "zellij", "wezterm"]),
  muxSession: z.string(),
  model: text,
  tools: z.array(text),
  thinking: text.optional(),
  state: SubagentStatus.shape.state,
});
type Launch = z.infer<typeof Launch>;
const SavedState = z.strictObject({ runs: z.array(Launch), delivered: z.array(text) });
const parentTools = new Set(["subagent", "subagents_list", "subagent_interrupt", "subagent_resume"]);

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

function agents(learningDir: string) {
  const definitions = new Map<string, z.infer<typeof AgentMetadata> & { prompt: string }>();
  for (const directory of [packageAgents, join(getAgentDir(), "agents"), join(learningDir, ".omp", "agents")]) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = join(directory, entry.name);
      const content = readFileSync(file, "utf8");
      // Only delimit the frontmatter here; Bun's maintained parser owns YAML syntax.
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
      if (!frontmatter) throw new Error(`Agent requires YAML frontmatter: ${file}`);
      try {
        const metadata = AgentMetadata.parse(YAML.parse(frontmatter[1]!));
        definitions.set(metadata.name, { ...metadata, prompt: content.slice(frontmatter[0].length).trim() });
      } catch (error) {
        throw new Error(`Invalid agent definition ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return definitions;
}

function muxSession(backend: Launch["backend"]): string {
  switch (backend) {
    case "zellij": return process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "";
    case "tmux": return process.env.TMUX ?? "";
    case "cmux": return process.env.CMUX_SOCKET_PATH ?? "";
    case "wezterm": return process.env.WEZTERM_UNIX_SOCKET ?? "";
  }
}

function processAlive(directory: string): boolean | undefined {
  const file = join(directory, "process.pid");
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid child process identity: ${file}`);
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

export function registerInteractive(pi: ExtensionAPI, config: LearnConfig): void {
  const Type = pi.typebox.Type;
  const root = join(config.learningDir, ".omp-learn", "subagents");
  let context: ExtensionContext | undefined;
  let timer: ReturnType<ExtensionContext["setInterval"]> | undefined;
  const runs = new Map<string, Launch>();
  const delivered = new Set<string>();
  const monitors = new Map<string, AbortController>();
  let widget = "";
  // Serialize only launch/resume mutation. Once dispatched, each TUI runs independently.
  let launchQueue: Promise<unknown> = Promise.resolve();

  function persist(): void {
    pi.appendEntry(STATE, { runs: [...runs.values()], delivered: [...delivered] } satisfies z.infer<typeof SavedState>);
  }

  function updateWidget(): void {
    const next = [...runs.values()].map(item => `${item.run.name}: ${item.state === "done" ? "finished" : item.state}`).join(" | ");
    if (next === widget) return;
    widget = next;
    context?.ui.setStatus("omp-learn-subagents", next || undefined);
  }

  function assertMux(item?: Launch): NonNullable<ReturnType<typeof getMuxBackend>> {
    const backend = getMuxBackend();
    if (!backend) throw new Error("No supported multiplexer is available. Start omp inside Zellij (zellij --session learning), with zellij on PATH. No background fallback is used.");
    if (item && (backend !== item.backend || muxSession(backend) !== item.muxSession)) {
      throw new Error(`Child ${item.run.name} belongs to a different ${item.backend} session; pane ${item.surface} will not be targeted here.`);
    }
    return backend;
  }

  function deliver(item: Launch, result: SubagentResult): void {
    if (delivered.has(item.run.id)) return;
    item.state = result.status;
    delivered.add(item.run.id);
    persist();
    monitors.get(item.run.id)?.abort();
    monitors.delete(item.run.id);
    pi.sendMessage({
      customType: RESULT,
      content: `Subagent ${JSON.stringify(item.run.name)} (${item.run.agent}) reported ${result.status}.\n${result.summary}\nSession: ${result.sessionFile}\nRun: ${result.id}`,
      display: true,
      details: { ...result, name: item.run.name, agent: item.run.agent },
    }, { triggerTurn: true, deliverAs: "steer" });
    updateWidget();
  }

  function failure(item: Launch, summary: string): void {
    deliver(item, SubagentResult.parse({ id: item.run.id, status: "error", summary, sessionFile: item.run.sessionFile, updatedAt: Date.now() }));
  }

  function inspect(item: Launch): void {
    if (delivered.has(item.run.id)) return;
    try {
      const resultFile = join(item.directory, "result.json");
      if (existsSync(resultFile)) {
        const result = SubagentResult.parse(JSON.parse(readFileSync(resultFile, "utf8")));
        if (result.id !== item.run.id || canonicalPath(result.sessionFile) !== canonicalPath(item.run.sessionFile)) throw new Error("Child result identity does not match its launched run/session");
        deliver(item, result);
        return;
      }
      const statusFile = join(item.directory, "status.json");
      if (existsSync(statusFile)) {
        const status = SubagentStatus.parse(JSON.parse(readFileSync(statusFile, "utf8")));
        if (status.id !== item.run.id) throw new Error("Child status identity does not match its launched run");
        // A terminal status is not proof of successful completion: wait for its result.
        if (status.state === "starting" || status.state === "active" || status.state === "waiting") item.state = status.state;
      }
      const exitFile = join(item.directory, "process.exit");
      if (existsSync(exitFile)) {
        const code = readFileSync(exitFile, "utf8").trim();
        failure(item, `OMP exited with code ${code} without a terminal result. Its saved conversation remains resumable.`);
      } else {
        const alive = processAlive(item.directory);
        if (alive === false) failure(item, "Child OMP process disappeared without a terminal result. Its saved conversation remains resumable.");
        else if (alive === undefined && Date.now() - item.run.createdAt > 30_000) failure(item, "Child pane never started its OMP launch script within 30 seconds; inspect the pane before resuming.");
      }
    } catch (error) {
      failure(item, `Cannot monitor child: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function monitor(item: Launch): void {
    inspect(item);
    if (delivered.has(item.run.id) || monitors.has(item.run.id)) return;
    // Disk status monitoring continues even when a parent resumes outside its old mux.
    if (getMuxBackend() !== item.backend || muxSession(item.backend) !== item.muxSession) return;
    const controller = new AbortController();
    monitors.set(item.run.id, controller);
    void pollForExit(item.surface, controller.signal, { interval: 1500 }).then(exit => {
      if (controller.signal.aborted || runs.get(item.run.id) !== item) return;
      inspect(item);
      if (!delivered.has(item.run.id)) failure(item, `OMP exited with code ${exit.exitCode} without a terminal result. Resume the saved session to continue.`);
    }).catch(error => {
      if (!controller.signal.aborted && runs.get(item.run.id) === item) failure(item, `Multiplexer monitor failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (monitors.get(item.run.id) === controller) monitors.delete(item.run.id);
    });
  }

  function stop(): void {
    if (timer !== undefined) context?.clearTimer(timer);
    timer = undefined;
    for (const controller of monitors.values()) controller.abort();
    monitors.clear();
  }

  function restore(ctx: ExtensionContext): void {
    stop();
    context = ctx;
    runs.clear();
    delivered.clear();
    let saved: z.infer<typeof SavedState> | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE) saved = SavedState.parse(entry.data);
    }
    for (const item of saved?.runs ?? []) {
      if (canonicalPath(item.directory) !== join(canonicalPath(root), item.run.id) || !inside(config.learningDir, canonicalPath(item.directory)) || !inside(config.learningDir, canonicalPath(item.run.sessionFile))) {
        ctx.ui.notify(`Ignoring invalid child run path for ${item.run.name}`, "error");
        continue;
      }
      runs.set(item.run.id, item);
    }
    for (const id of saved?.delivered ?? []) delivered.add(id);
    widget = "";
    ctx.ui.setStatus("omp-learn-subagents", undefined);
    for (const item of runs.values()) monitor(item);
    updateWidget();
    timer = ctx.setInterval(() => {
      for (const item of runs.values()) inspect(item);
      updateWidget();
    }, 1000);
  }

  async function launch(options: { name: string; agent: string; task?: string; model: string; tools: string[]; thinking?: string; prompt: string; cwd: string; autoExit: boolean; sessionFile?: string }, ctx: ExtensionContext): Promise<Launch> {
    if (ctx.mode !== "tui") throw new Error("Interactive subagents require a parent OMP TUI session.");
    const backend = assertMux();
    const executable = Bun.which("omp");
    if (!executable) throw new Error("The omp executable is missing from PATH; genuine OMP child TUIs cannot start.");
    const configFile = process.env.OMP_LEARN_CONFIG;
    if (!configFile || !existsSync(configFile)) throw new Error("OMP_LEARN_CONFIG must identify the parent's existing learning configuration.");
    if ([...runs.values()].some(item => item.run.name === options.name && !existsSync(join(item.directory, "process.exit")) && processAlive(item.directory) !== false)) {
      throw new Error(`A live child is already named ${options.name}; choose another name or exit its pane first.`);
    }
    if (!inside(config.learningDir, canonicalPath(root))) throw new Error("Subagent storage must remain inside learningDir (including symlink targets).");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const directory = join(root, id);
    mkdirSync(directory, { mode: 0o700 });
    let sessionFile = options.sessionFile;
    if (!sessionFile) {
      const manager = SessionManager.create(options.cwd, directory);
      try {
        await manager.ensureOnDisk();
        sessionFile = manager.getSessionFile();
        if (!sessionFile) throw new Error("OMP did not allocate a persistent child session");
      } finally { await manager.close(); }
    }
    const run = SubagentRun.parse({ id, name: options.name, agent: options.agent, cwd: options.cwd, sessionFile, autoExit: options.autoExit, createdAt: Date.now() });
    atomicJson(join(directory, "run.json"), run);
    atomicJson(join(directory, "status.json"), { id, state: "starting", updatedAt: Date.now() });
    const roleFile = join(directory, "role.txt");
    writeFileSync(roleFile, options.prompt, { flag: "wx", mode: 0o600 });
    const args = ["--resume", run.sessionFile, "--no-extensions", "--extension", extensionFile, "--append-system-prompt", roleFile, "--model", options.model, "--tools", options.tools.join(",")];
    if (options.thinking) args.push("--thinking", options.thinking);
    if (options.task) {
      const taskFile = join(directory, "task.txt");
      writeFileSync(taskFile, options.task, { flag: "wx", mode: 0o600 });
      args.push(`@${taskFile}`);
    }
    const surface = createSurface(options.name);
    const item: Launch = { run, directory, surface, backend, muxSession: muxSession(backend), model: options.model, tools: options.tools, thinking: options.thinking, state: "starting" };
    runs.set(id, item);
    persist();
    const pidFile = shellEscape(join(directory, "process.pid"));
    const exitFile = shellEscape(join(directory, "process.exit"));
    const exitTemporary = shellEscape(join(directory, "process.exit.tmp"));
    const command = [
      "umask 077",
      `finish() { code=$?; printf '%s\\n' "$code" > ${exitTemporary}; mv ${exitTemporary} ${exitFile}; printf '__SUBAGENT_DONE_%s__\\n' "$code"; }`,
      "trap finish EXIT",
      "trap 'exit 129' HUP",
      `printf '%s\\n' "$$" > ${pidFile}`,
      `cd ${shellEscape(options.cwd)} || exit 1`,
      `export OMP_LEARN_CONFIG=${shellEscape(realpathSync(configFile))} OMP_LEARN_CHILD=${shellEscape(directory)}`,
      [executable, ...args].map(shellEscape).join(" "),
      "exit $?",
    ].join("\n");
    try {
      sendLongCommand(surface, command, { scriptPath: join(directory, "launch.sh") });
    } catch (error) {
      try { closeSurface(surface); } catch { /* Preserve the original launch error. */ }
      failure(item, `Failed to launch OMP pane: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    monitor(item);
    updateWidget();
    return item;
  }

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = launchQueue.then(action);
    launchQueue = pending.catch(() => undefined);
    return pending;
  }

  function findRun(idOrName: string): Launch {
    const exact = runs.get(idOrName);
    if (exact) return exact;
    const matches = [...runs.values()].filter(item => item.run.name === idOrName);
    if (!matches.length) throw new Error(`No child named ${idOrName} on this session branch`);
    return matches[matches.length - 1]!;
  }

  function output(item: Launch) {
    return { id: item.run.id, name: item.run.name, agent: item.run.agent, state: item.state, sessionPath: item.run.sessionFile, pane: item.surface, autoExit: item.run.autoExit };
  }

  pi.registerTool({
    name: "subagent", label: "Interactive subagent", loadMode: "essential",
    description: "Launch a named, independently interactive OMP TUI in a multiplexer pane and return immediately. Agent definitions: package agents, global OMP agents, then learningDir/.omp/agents (project wins). Completion/help/failure arrives as a typed parent message. interactive=true leaves the child open for conversation; default false exits after completion. cwd must remain inside learningDir.",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), agent: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }), model: Type.Optional(Type.String({ minLength: 1 })), interactive: Type.Optional(Type.Boolean()), cwd: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const definitions = agents(config.learningDir);
        const definition = definitions.get(params.agent);
        if (!definition) throw new Error(`Unknown agent ${params.agent}. Available: ${[...definitions.keys()].join(", ")}`);
        const cwd = realpathSync(expandPath(params.cwd ?? config.learningDir, config.learningDir));
        if (!inside(config.learningDir, cwd) || !statSync(cwd).isDirectory()) throw new Error("Child cwd must be a directory inside learningDir");
        const preferences = params.model ? [params.model] : definition.model ? typeof definition.model === "string" ? [definition.model] : definition.model : [];
        const selected = preferences.length ? preferences.map(spec => ctx.models.resolve(spec)).find(model => model !== undefined) : ctx.model;
        if (!selected) throw new Error(`No available child model${preferences.length ? ` matches ${preferences.join(", ")}` : "; select a parent model first"}`);
        const allowed = [...new Set([...(definition.tools ?? pi.getActiveTools().filter(tool => !parentTools.has(tool))), "subagent_done", "caller_ping"])];
        const item = await launch({ name: params.name, agent: definition.name, task: params.task, model: `${selected.provider}/${selected.id}`, tools: allowed, thinking: definition["thinking-level"] ?? definition.thinkingLevel ?? definition.thinking, prompt: definition.prompt, cwd, autoExit: !(params.interactive ?? false) }, ctx);
        const details = output(item);
        return { content: [{ type: "text", text: `Launched ${item.run.name} in ${item.backend} pane ${item.surface}. Parent remains available. Session: ${item.run.sessionFile}` }], details };
      });
    },
  });

  pi.registerTool({
    name: "subagents_list", label: "List interactive subagents", loadMode: "essential", approval: "read",
    description: "List branch-scoped child names, active/waiting/finished states, pane IDs, and resumable session paths. Also lists available agent definitions.",
    parameters: Type.Object({}),
    async execute() {
      for (const item of runs.values()) inspect(item);
      updateWidget();
      const details = { runs: [...runs.values()].map(output), agents: [...agents(config.learningDir).values()].map(({ name, description }) => ({ name, description })) };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "subagent_interrupt", label: "Interrupt interactive subagent", loadMode: "essential",
    description: "Send Escape to one explicitly targeted child pane. Aborts the current turn without closing the OMP TUI or deleting its saved conversation; the learner may type directly in that pane.",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      const item = findRun(params.name);
      assertMux(item);
      if (existsSync(join(item.directory, "process.exit")) || processAlive(item.directory) === false) throw new Error("Child already exited; use subagent_resume with its session path");
      sendEscape(item.surface);
      return { content: [{ type: "text", text: `Escape sent to ${item.run.name} (${item.surface}). Its TUI remains open; wait for the interrupted turn to stop, then type there. To reopen via subagent_resume, exit that child TUI first. Session: ${item.run.sessionFile}` }], details: output(item) };
    },
  });

  pi.registerTool({
    name: "subagent_resume", label: "Resume interactive subagent", loadMode: "essential",
    description: "Reopen a previously launched child's native OMP session without replacing its transcript. Requires its old OMP TUI to have exited (never starts two writers). Each resume gets a fresh run/pane and one new completion. Omit message to open the existing conversation for direct typing. autoExit defaults true.",
    parameters: Type.Object({ sessionPath: Type.String({ minLength: 1 }), name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), message: Type.Optional(Type.String({ minLength: 1 })), autoExit: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const sessionFile = realpathSync(expandPath(params.sessionPath, config.learningDir));
        if (!inside(config.learningDir, sessionFile)) throw new Error("Child sessions must stay inside learningDir");
        const prior = [...runs.values()].filter(item => canonicalPath(item.run.sessionFile) === sessionFile);
        const previous = prior[prior.length - 1];
        if (!previous) throw new Error("Only a child session launched on the current parent branch can be resumed");
        for (const item of prior) {
          if (!existsSync(join(item.directory, "process.exit")) && processAlive(item.directory) !== false) throw new Error(`Child ${item.run.name} still has this transcript open. Type in its existing pane, or exit that OMP TUI before reopening it. Interrupt alone intentionally leaves the TUI alive.`);
          inspect(item);
        }
        const cwd = realpathSync(previous.run.cwd);
        if (!inside(config.learningDir, cwd)) throw new Error("Saved child cwd is no longer inside learningDir");
        const item = await launch({ name: params.name ?? previous.run.name, agent: previous.run.agent, task: params.message, model: previous.model, tools: previous.tools, thinking: previous.thinking, prompt: readFileSync(join(previous.directory, "role.txt"), "utf8"), cwd, autoExit: params.autoExit ?? true, sessionFile }, ctx);
        return { content: [{ type: "text", text: `Resumed ${item.run.name} in ${item.backend} pane ${item.surface}. Existing transcript preserved: ${sessionFile}` }], details: output(item) };
      });
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_switch", (_event, ctx) => restore(ctx));
  pi.on("session_branch", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { stop(); context = undefined; });
}
