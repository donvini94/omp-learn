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
