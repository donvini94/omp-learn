import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LearnConfig } from "./config";
import { z } from "zod";

const AppendResult = z.strictObject({ inserted: z.boolean() });

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../emacs/omp-learn.el", import.meta.url));

export interface OrgAppend {
  file: string;
  id: string;
  text: string;
  kind: "log" | "anki";
  preamble?: string;
  heading?: string;
}

async function evaluate(config: LearnConfig, expression: string): Promise<string> {
  try {
    const result = await execute(config.emacsclient, ["--eval", `(let ((debug-on-error nil) (debug-on-quit nil)) (load ${JSON.stringify(helper)} nil t) ${expression})`], {
      timeout: 120_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`Emacs lesson integration failed. Start your Emacs server and resolve any unsaved-file conflicts. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkEmacs(config: LearnConfig): Promise<void> {
  await evaluate(config, '(and (featurep \'org) (fboundp \'omp-learn-append-file))');
}

export async function appendOrg(config: LearnConfig, request: OrgAppend): Promise<{ inserted: boolean }> {
  const root = join(config.learningDir, ".omp-learn", "requests");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(root, "append-"));
  const file = join(temp, "request.json");
  try {
    await writeFile(file, JSON.stringify({ ...request, learningDir: config.learningDir, ankiFile: config.ankiFile }), { mode: 0o600 });
    const printed = await evaluate(config, `(omp-learn-append-file ${JSON.stringify(file)})`);
    return AppendResult.parse(JSON.parse(z.string().parse(JSON.parse(printed))));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function openLog(config: LearnConfig, file: string): Promise<void> {
  await evaluate(config, `(omp-learn-open ${JSON.stringify(file)})`);
}
