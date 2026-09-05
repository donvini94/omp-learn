import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { LearnConfig } from "./config";
import { expandPath } from "./config";
import { canonicalPath, inside } from "./access";
import { appendOrg, checkEmacs, openLog } from "./emacs";
import { markdownToOrg, oneLine, orgFileLink } from "./org";

const STATE = "omp-learn-org.notebook";
const LogState = z.strictObject({ file: z.string().nullable() });
const Option = z.object({ index: z.number(), label: z.string() });
const Recall = z.object({ question: z.string().trim().min(1), answer: z.string().trim().min(1), sources: z.array(z.string()).optional() });
const Quiz = z.object({
  status: z.enum(["answered", "cancelled", "unavailable"]),
  question: z.string(), context: z.string().optional(),
  options: z.array(Option).optional(), answers: z.array(Option).default([]),
  correctIndices: z.array(z.number()).default([]), correct: z.boolean().optional(),
  dontKnow: z.boolean().optional(), note: z.string().optional(), explanation: z.string().optional(),
  recall: Recall.optional(),
});
const VisibleMessage = z.object({ role: z.enum(["user", "assistant"]), timestamp: z.number(), content: z.union([z.string(), z.array(z.unknown())]) });
const PartialQuiz = z.object({ details: z.object({ options: z.array(Option) }) });
const QuestionArgs = z.object({ question: z.string(), details: z.string().optional() });
const AskArgs = z.object({ questions: z.array(z.object({ question: z.string(), options: z.array(z.object({ label: z.string(), description: z.string().nullish() })) })) });

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n\n");
}

function messageRecord(message: unknown): { id: string; title: string; text: string } | undefined {
  const parsed = VisibleMessage.safeParse(message);
  if (!parsed.success) return undefined;
  const { role, timestamp, content } = parsed.data;
  const text = textContent(content).trim();
  if (!text) return undefined;
  // message_end precedes native session persistence. The immutable timestamp,
  // role and visible content identify the same message during later backfill.
  const id = `message-${createHash("sha256").update(JSON.stringify([role, timestamp, text])).digest("hex")}`;
  return { id, title: role === "user" ? "Learner" : "Teacher", text };
}

export function registerNotebook(pi: ExtensionAPI, config: LearnConfig) {
  let logFile: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  const completed = new Set<string>();

  function enqueue(ctx: ExtensionContext, action: () => Promise<void>): Promise<void> {
    const pending = queue.then(action);
    queue = pending.catch(error => {
      ctx.ui.notify(`Learning export failed: ${error instanceof Error ? error.message : String(error)}. Use /org-log to replay after fixing it.`, "error");
    });
    return pending;
  }

  function target(file: string): string {
    const absolute = canonicalPath(expandPath(file, config.learningDir));
    if (!inside(config.learningDir, absolute) || !absolute.endsWith(".org")) {
      throw new Error("Learning logs must be .org files inside the configured learning directory");
    }
    return absolute;
  }

  async function record(file: string, id: string, title: string, markdown: string): Promise<void> {
    const key = `${file}:${id}`;
    if (completed.has(key)) return;
    const body = await markdownToOrg(config, markdown, file);
    await appendOrg(config, { file, kind: "log", id, text: `* ${oneLine(title)}\n:PROPERTIES:\n:OMP_EVENT_ID: ${id}\n:END:\n${body}\n` });
    completed.add(key);
  }

  async function quizQuestion(file: string, id: string, question: string, context: string | undefined, options: z.infer<typeof Option>[]): Promise<void> {
    await record(file, `quiz-question-${id}`, "Quiz", [question, context, options.map(option => `${option.index}. ${option.label}`).join("\n")].filter(Boolean).join("\n\n"));
  }

  async function quizResult(file: string, id: string, raw: unknown): Promise<void> {
    const result = Quiz.parse(raw);
    await quizQuestion(file, id, result.question, result.context, result.options || []);
    if (result.status !== "answered") {
      await record(file, `quiz-answer-${id}`, `Quiz — ${result.status}`, "No answer was submitted.");
      return;
    }
    const answer = result.dontKnow ? "I don't know" : result.answers.map(option => `${option.index}. ${option.label}`).join(", ");
    const correct = result.correctIndices.map(index => result.options?.find(option => option.index === index)?.label || String(index)).join("; ");
    await record(file, `quiz-answer-${id}`, result.dontKnow ? "Quiz — unknown" : result.correct ? "Quiz — correct" : "Quiz — incorrect", [
      `Your answer: ${answer}`, result.note && `Your reasoning: ${result.note}`, `Correct answer: ${correct}`, result.explanation,
    ].filter(Boolean).join("\n\n"));
    if (!config.ankiFile) return;
    const recall = Recall.parse(result.recall);
    const key = `${config.ankiFile}:${id}`;
    if (completed.has(key)) return;
    const front = await markdownToOrg(config, recall.question, config.ankiFile, 3);
    const back = await markdownToOrg(config, [recall.answer, result.explanation, recall.sources?.length ? `Sources:\n\n${recall.sources.map(source => `- ${source}`).join("\n")}` : undefined].filter(Boolean).join("\n\n"), config.ankiFile, 3);
    await appendOrg(config, {
      file: config.ankiFile, id, kind: "anki", heading: config.ankiHeading,
      text: `** ${oneLine(recall.question)} :omp_learning:\n:PROPERTIES:\n:ANKI_NOTE_TYPE: Basic\n:ANKI_DECK: ${config.ankiDeck}\n:OMP_QUIZ_ID: ${id}\n:END:\n*** Front\n${front}\n*** Back\n${back}\n\n${orgFileLink(file, config.ankiFile, "Learning log")}\n`,
    });
    completed.add(key);
  }

  async function replay(file: string, ctx: ExtensionContext): Promise<void> {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      const visible = messageRecord(msg);
      if (visible) await record(file, visible.id, visible.title, visible.text);
      if (msg.role === "toolResult" && msg.toolName === "quiz") await quizResult(file, msg.toolCallId, msg.details);
      if (msg.role === "toolResult" && msg.toolName === "ask") await record(file, `ask-answer-${msg.toolCallId}`, "Learner — response", textContent(msg.content));
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type !== "toolCall" || part.name !== "ask") continue;
          const args = AskArgs.parse(part.arguments);
          await record(file, `ask-question-${part.id}`, "Question", args.questions.map(q => [q.question, q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")].join("\n\n")).join("\n\n"));
        }
      }
    }
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    await queue;
    logFile = undefined;
    completed.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE) {
        const state = LogState.parse(entry.data);
        logFile = state.file ? target(state.file) : undefined;
      }
    }
    ctx.ui.setStatus("omp-learn", logFile ? `Lesson: ${basename(logFile)}` : undefined);
    if (logFile) {
      const file = logFile;
      await enqueue(ctx, () => replay(file, ctx));
    }
  }

  async function link(file: string, ctx: ExtensionCommandContext): Promise<void> {
    await queue;
    if (!ctx.isIdle()) throw new Error("Wait for the teacher to finish before changing logs");
    const absolute = target(file);
    if (!existsSync(absolute)) throw new Error("Use /lesson <goal> to create a new learning log");
    await checkEmacs(config);
    logFile = absolute;
    pi.appendEntry(STATE, { file: logFile });
    ctx.ui.setStatus("omp-learn", `Lesson: ${basename(logFile)}`);
    await enqueue(ctx, () => replay(absolute, ctx));
    await openLog(config, absolute);
  }

  async function start(title: string, ctx: ExtensionCommandContext): Promise<string> {
    if (logFile) return logFile;
    if (!ctx.isIdle()) throw new Error("Wait for the teacher to finish before starting a lesson");
    await checkEmacs(config);
    const node = randomUUID();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "lesson";
    const file = join(config.learningDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}-${node.slice(0, 8)}.org`);
    await appendOrg(config, {
      file, id: `session-${ctx.sessionManager.getSessionId()}`, kind: "log",
      preamble: `:PROPERTIES:\n:ID: ${node}\n:END:\n#+title: ${oneLine(title)}\n#+filetags: :learning_log:\n#+STARTUP: inlineimages latexpreview\n`,
      text: `* Learning goal\n:PROPERTIES:\n:OMP_EVENT_ID: session-${ctx.sessionManager.getSessionId()}\n:END:\n${await markdownToOrg(config, title, file)}\n`,
    });
    logFile = file;
    pi.appendEntry(STATE, { file });
    ctx.ui.setStatus("omp-learn", `Lesson: ${basename(file)}`);
    await openLog(config, file);
    return file;
  }

  function unlink(ctx: ExtensionContext): void {
    logFile = undefined;
    pi.appendEntry(STATE, { file: null });
    ctx.ui.setStatus("omp-learn", undefined);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_switch", (_event, ctx) => restore(ctx));
  pi.on("session_branch", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async () => { await queue; });
  pi.on("message_end", (event, ctx) => {
    const file = logFile;
    if (!file) return;
    const visible = messageRecord(event.message);
    if (visible) return enqueue(ctx, () => record(file, visible.id, visible.title, visible.text));
  });
  pi.on("tool_call", (event, ctx) => {
    const file = logFile;
    if (!file || event.toolName !== "ask") return;
    const args = AskArgs.parse(event.input);
    return enqueue(ctx, () => record(file, `ask-question-${event.toolCallId}`, "Question", args.questions.map(q => [q.question, q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")].join("\n\n")).join("\n\n")));
  });
  pi.on("tool_execution_update", (event, ctx) => {
    const file = logFile;
    if (!file || event.toolName !== "quiz") return;
    const partial = PartialQuiz.safeParse(event.partialResult);
    if (!partial.success) return;
    const args = QuestionArgs.parse(event.args);
    return enqueue(ctx, () => quizQuestion(file, event.toolCallId, args.question, args.details, partial.data.details.options));
  });
  pi.on("tool_result", (event, ctx) => {
    const file = logFile;
    if (!file) return;
    if (event.toolName === "quiz") return enqueue(ctx, () => quizResult(file, event.toolCallId, event.details));
    if (event.toolName === "ask") return enqueue(ctx, () => record(file, `ask-answer-${event.toolCallId}`, "Learner — response", textContent(event.content)));
  });
  pi.registerCommand("org-log", {
    description: "Open/replay the current log, or link an existing learning .org file",
    handler: async (args, ctx) => {
      try {
        const file = args.trim() || logFile;
        if (!file) throw new Error("Start with /lesson <learning goal>");
        await link(file, ctx);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("org-unlog", { description: "Stop logging without modifying the existing lesson", handler: async (_args, ctx) => { await queue; unlink(ctx); } });
  return { getLogFile: () => logFile, start, link, unlink };
}
