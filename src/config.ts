import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const ConfigFile = z.strictObject({
  learningDir: text.default(".."),
  ankiFile: text.optional(),
  ankiHeading: text.regex(/^[^\r\n]+$/).default("Dispatch Shelf"),
  ankiDeck: text.regex(/^[^\r\n]+$/).default("Default"),
  emacsclient: text.default("emacsclient"),
  pandoc: text.default("pandoc"),
  browserExecutable: text.optional(),
});

export interface LearnConfig {
  learningDir: string;
  ankiFile?: string;
  ankiHeading: string;
  ankiDeck: string;
  emacsclient: string;
  pandoc: string;
  browserExecutable?: string;
}

export function expandPath(value: string, base = process.cwd()): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return resolve(base, expanded);
}

export function loadConfig(cwd: string): LearnConfig | undefined {
  const file = process.env.OMP_LEARN_CONFIG || join(cwd, ".omp", "learn.json");
  if (!existsSync(file)) return undefined;
  const values = ConfigFile.parse(JSON.parse(readFileSync(file, "utf8")));
  const base = dirname(resolve(file));
  const learningDir = realpathSync(expandPath(values.learningDir, base));
  const ankiFile = values.ankiFile ? expandPath(values.ankiFile, base) : undefined;
  // Workers inherit the same explicit configuration, never search the notes tree.
  process.env.OMP_LEARN_CONFIG = resolve(file);
  return {
    learningDir,
    ankiFile,
    ankiHeading: values.ankiHeading,
    ankiDeck: values.ankiDeck,
    emacsclient: values.emacsclient,
    pandoc: values.pandoc,
    browserExecutable: values.browserExecutable ? expandPath(values.browserExecutable, base) : undefined,
  };
}

/**
 * A resumed subagent starts in the multiplexer pane's directory, not the lesson's, so the
 * session header's recorded cwd is the only place its workspace is knowable. HazAT's resume
 * launcher exports PI_SUBAGENT_SESSION with the explicit session path.
 */
function sessionCwd(sessionPath: string): string | undefined {
  try {
    const header: unknown = JSON.parse(readFileSync(sessionPath, "utf8").split("\n", 1)[0] ?? "");
    if (header && typeof header === "object" && "cwd" in header && typeof header.cwd === "string") return header.cwd;
  } catch {
    // An unreadable header yields no workspace, which leaves the session unconfigured.
  }
  return undefined;
}

export function loadPiConfig(cwd: string): LearnConfig | undefined {
  const resumed = process.env.PI_SUBAGENT_SESSION ? sessionCwd(process.env.PI_SUBAGENT_SESSION) : undefined;
  const file = process.env.PI_LEARN_CONFIG || join(resumed && !existsSync(join(cwd, ".pi", "learn.json")) ? resumed : cwd, ".pi", "learn.json");
  if (!existsSync(file)) return undefined;
  const values = ConfigFile.parse(JSON.parse(readFileSync(file, "utf8")));
  const base = dirname(resolve(file));
  const learningDir = realpathSync(expandPath(values.learningDir, base));
  const ankiFile = values.ankiFile ? expandPath(values.ankiFile, base) : undefined;
  // Pi child sessions inherit this explicit configuration instead of searching notes.
  process.env.PI_LEARN_CONFIG = resolve(file);
  return {
    learningDir,
    ankiFile,
    ankiHeading: values.ankiHeading,
    ankiDeck: values.ankiDeck,
    emacsclient: values.emacsclient,
    pandoc: values.pandoc,
    browserExecutable: values.browserExecutable ? expandPath(values.browserExecutable, base) : undefined,
  };
}
