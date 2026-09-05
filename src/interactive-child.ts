import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import type { LearnConfig } from "./config";
import { SubagentResult, SubagentRun, SubagentStatus } from "./subagent-protocol";

type Message = AgentEndEvent["messages"][number];
type Assistant = Extract<Message, { role: "assistant" }>;
type State = z.infer<typeof SubagentStatus>["state"];
type Completion = { status: "done" | "help"; summary: string };
type PendingCompletion = Completion & {
  toolCallId: string;
  signal: AbortSignal | undefined;
  stopping: boolean;
};
const RESULT_ENTRY = "omp-learn.child-result";

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function assistantText(message: Assistant): string {
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
}

function latestAssistant(messages: readonly Message[]): Assistant | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

// Completion is published only after a real native settle; native shutdown owns
// draining event handlers and flushing the session, never a process.exit here.
export function registerInteractiveChild(pi: ExtensionAPI, config: LearnConfig): void {
  const directory = process.env.OMP_LEARN_CHILD;
  if (!directory) throw new Error("OMP_LEARN_CHILD must identify this child's private run directory");
  const root = realpathSync(config.learningDir);
  const runDir = realpathSync(directory);
  const runsDir = join(root, ".omp-learn", "subagents");
  if (!inside(runsDir, runDir) || runDir === runsDir) {
    throw new Error("Child run directory must be inside learningDir/.omp-learn/subagents");
  }
  const descriptor = join(runDir, "run.json");
  if (realpathSync(descriptor) !== descriptor) throw new Error("Child run descriptor must not be a symlink");
  const run = SubagentRun.parse(JSON.parse(readFileSync(descriptor, "utf8")));
  if (basename(runDir) !== run.id || runDir !== join(runsDir, run.id)) {
    throw new Error("Child run directory does not match its descriptor ID");
  }
  const cwd = realpathSync(run.cwd);
  const sessionFile = realpathSync(run.sessionFile);
  if (!inside(root, cwd) || !inside(root, sessionFile) || realpathSync(process.cwd()) !== cwd) {
    throw new Error("Child cwd and session must belong to the configured learning directory and match the descriptor");
  }

  const Type = pi.typebox.Type;
  let state: State = "starting";
  let finished = false;
  let shuttingDown = false;
  let pending: PendingCompletion | undefined;
  let boundary: Promise<void> | undefined;
  let observedAssistant: Assistant | undefined;
  let observedTurn = false;

  function atomic(file: "status.json" | "result.json", value: unknown): void {
    // Re-check the directory before every mutation so replacing it with a
    // symlink cannot redirect a running child's output outside the workspace.
    if (realpathSync(runDir) !== runDir) throw new Error("Child run directory identity changed");
    const temporary = join(runDir, `.${file}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    try {
      renameSync(temporary, join(runDir, file));
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
  }

  function identity(ctx: ExtensionContext): void {
    const actual = ctx.sessionManager.getSessionFile();
    if (realpathSync(ctx.cwd) !== cwd || realpathSync(ctx.sessionManager.getCwd()) !== cwd ||
      !actual || realpathSync(actual) !== sessionFile) {
      throw new Error("Native child session identity does not match run.json");
    }
  }

  function status(next: State): void {
    atomic("status.json", SubagentStatus.parse({ id: run.id, state: next, updatedAt: Date.now() }));
    state = next;
  }

  // OMP's TUI only consumes ctx.shutdown() inside its interactive submission
  // path, so a child whose task arrived on the command line would stay open
  // forever. Request the graceful path first, then close the process once the
  // completion entry is durably in the session file the parent will resume.
  function persisted(): boolean {
    return readFileSync(sessionFile, "utf8").includes(RESULT_ENTRY);
  }

  function finish(result: Completion | { status: "error"; summary: string }, ctx: ExtensionContext): void {
    if (finished) return;
    identity(ctx);
    const value = SubagentResult.parse({ ...result, id: run.id, sessionFile, updatedAt: Date.now() });
    pi.appendEntry(RESULT_ENTRY, value);
    atomic("result.json", value);
    status(result.status);
    finished = true;
    ctx.shutdown();
    const deadline = Date.now() + 5_000;
    const close = () => {
      if (persisted() || Date.now() >= deadline) process.exit(0);
      ctx.setTimeout(close, 50);
    };
    ctx.setTimeout(close, 50);
  }

  function activity(_event: unknown, ctx: ExtensionContext): void {
    if (finished || shuttingDown || pending?.stopping) return;
    identity(ctx);
    status("active");
  }

  function branchMessages(ctx: ExtensionContext): Message[] {
    return ctx.sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
  }

  function summary(ctx: ExtensionContext): string {
    if (observedAssistant) {
      const text = assistantText(observedAssistant);
      if (text) return text;
    }
    const messages = branchMessages(ctx);
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") {
        const text = assistantText(message);
        if (text) return text;
      }
    }
    return "";
  }

  function stage(value: Completion, toolCallId: string, signal: AbortSignal | undefined, ctx: ExtensionContext): void {
    identity(ctx);
    signal?.throwIfAborted();
    if (finished || pending) throw new Error("A child completion is already pending");
    pending = { ...value, toolCallId, signal, stopping: false };
  }

  async function stopAfterPersistedTool(request: PendingCompletion, ctx: ExtensionContext): Promise<void> {
    // Extension turn_end precedes some fire-and-forget message persistence.
    // Wait until the completed result is in the native branch BEFORE abort():
    // abort advances OMP's prompt generation and would drop a late append.
    const deadline = Date.now() + 5_000;
    while (!branchMessages(ctx).some(message => message.role === "toolResult" &&
      message.toolCallId === request.toolCallId && !message.isError)) {
      if (request.signal?.aborted || shuttingDown || pending !== request) return;
      if (Date.now() >= deadline) throw new Error("Completed child tool result was not persisted in the native session branch");
      await new Promise<void>(resolve => ctx.setTimeout(() => resolve(), 0));
    }
    if (request.signal?.aborted || shuttingDown || pending !== request) return;
    identity(ctx);
    request.stopping = true;
    // This is a deliberate stop AFTER a successful, persisted completion tool,
    // not a successful interpretation of a user-aborted tool or assistant turn.
    // Blocking the next provider hook on this boundary avoids another API call.
    ctx.abort();
  }

  status("starting");
  pi.on("session_start", (_event, ctx) => {
    identity(ctx);
    ctx.ui.setStatus("omp-learn-child", `${run.name} (${run.agent})`);
    ctx.ui.notify("Interactive child session. /subagent-done [summary] returns to the parent; Escape pauses without completing.", "info");
  });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("agent_start", (event, ctx) => {
    observedAssistant = undefined;
    observedTurn = false;
    activity(event, ctx);
  });
  pi.on("turn_start", (event, ctx) => {
    observedTurn = true;
    activity(event, ctx);
  });
  pi.on("message_update", activity);
  pi.on("tool_call", activity);
  pi.on("tool_execution_start", activity);
  pi.on("tool_execution_update", activity);
  pi.on("tool_execution_end", (event, ctx) => {
    if (pending?.toolCallId === event.toolCallId && event.isError) pending = undefined;
    activity(event, ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") observedAssistant = event.message;
    activity(event, ctx);
  });
  pi.on("turn_end", (event, ctx) => {
    if (!pending || pending.stopping) return;
    const request = pending;
    const toolResult = event.toolResults.find(result => result.toolCallId === request.toolCallId);
    if (!toolResult) return;
    if (toolResult.isError || request.signal?.aborted ||
      (event.message.role === "assistant" && ["aborted", "error"].includes(event.message.stopReason))) {
      pending = undefined;
      return;
    }
    boundary = stopAfterPersistedTool(request, ctx);
    return boundary;
  });
  pi.on("before_provider_request", async (_event, ctx) => {
    if (boundary) await boundary;
    if (!pending?.stopping) activity(_event, ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    if (finished || shuttingDown) return;
    if (event.willContinue) {
      activity(event, ctx);
      return;
    }
    identity(ctx);
    if (pending?.stopping) {
      finish(pending, ctx);
      return;
    }
    pending = undefined;
    boundary = undefined;
    const last = observedAssistant ?? latestAssistant(event.messages);
    if (!run.autoExit || !observedTurn || !last || last.stopReason === "aborted" || ctx.hasPendingMessages()) {
      status("waiting");
      return;
    }
    if (last.stopReason === "error") {
      finish({ status: "error", summary: last.errorMessage ?? "Provider ended with stopReason=error without an errorMessage" }, ctx);
      return;
    }
    // Tool-use and token-limit stops are not completed autonomous answers.
    if (last.stopReason !== "stop" || last.content.some(part => part.type === "toolCall")) {
      status("waiting");
      return;
    }
    finish({ status: "done", summary: assistantText(last) }, ctx);
  });
  pi.on("session_shutdown", () => {
    shuttingDown = true;
    pending = undefined;
    if (!finished && state !== "waiting") status("waiting");
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description: "Complete this child and return a summary to its parent. Put your result in summary or in assistant text before this call. The saved session remains resumable.",
    parameters: Type.Object({ summary: Type.Optional(Type.String()) }),
    loadMode: "essential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      stage({ status: "done", summary: params.summary ?? summary(ctx) }, toolCallId, signal, ctx);
      return { content: [{ type: "text", text: "Completion accepted. The child will close after this tool result is saved." }], details: {} };
    },
  });
  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description: "Request help from the parent and close this child after saving its session. The parent can resume this conversation with a response.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    loadMode: "essential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      stage({ status: "help", summary: params.message }, toolCallId, signal, ctx);
      return { content: [{ type: "text", text: "Help request accepted. The child will close after this tool result is saved; the parent can resume it." }], details: {} };
    },
  });
  pi.registerCommand("subagent-done", {
    description: "Complete this child without a provider call: /subagent-done [summary]",
    handler: async (args, ctx) => {
      identity(ctx);
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Pause the active turn with Escape and clear queued messages before completing this child.", "warning");
        return;
      }
      await ctx.waitForIdle();
      finish({ status: "done", summary: args.trim() || summary(ctx) }, ctx);
    },
  });
}
