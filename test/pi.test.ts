import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { loadPiConfig } from "../src/config";

const root = new URL("../", import.meta.url);

test("shared teaching instructions use client-neutral tools and sessions", () => {
  for (const file of ["skills/teach/SKILL.md", "skills/study/SKILL.md", "skills/visualize/SKILL.md", "prompts/craft.md"]) {
    const text = readFileSync(new URL(file, root), "utf8");
    expect(text).not.toMatch(/\bOMP\b|`ask`|`questions` array/);
  }
  const researcher = readFileSync(new URL("pi/agents/researcher.md", root), "utf8");
  expect(researcher).toContain("web_fetch");
  expect(researcher).not.toContain("`web_search`");
});

test("Pi loads its own workspace and registers learning tools through the Pi SDK", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-learning-"));
  const previousPi = process.env.PI_LEARN_CONFIG;
  const previousOmp = process.env.OMP_LEARN_CONFIG;
  try {
    mkdirSync(join(directory, ".pi"));
    mkdirSync(join(directory, ".omp"));
    writeFileSync(join(directory, ".pi", "learn.json"), JSON.stringify({ learningDir: directory }));
    writeFileSync(join(directory, ".omp", "learn.json"), "not valid JSON");
    process.env.PI_LEARN_CONFIG = join(directory, ".pi", "learn.json");
    process.env.OMP_LEARN_CONFIG = join(directory, ".omp", "learn.json");
    expect(loadPiConfig(directory)?.learningDir).toBeDefined();
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: join(directory, "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [new URL("src/pi-index.ts", root).pathname],
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    const learning = result.extensions[0]!;
    expect(learning.commands.has("lesson")).toBe(true);
    expect(learning.commands.has("study")).toBe(true);
    expect(learning.tools.has("quiz")).toBe(true);
    expect(learning.tools.has("render_svg")).toBe(true);
    expect(learning.tools.has("render_mermaid")).toBe(true);
  } finally {
    if (previousPi === undefined) delete process.env.PI_LEARN_CONFIG;
    else process.env.PI_LEARN_CONFIG = previousPi;
    if (previousOmp === undefined) delete process.env.OMP_LEARN_CONFIG;
    else process.env.OMP_LEARN_CONFIG = previousOmp;
    rmSync(directory, { recursive: true, force: true });
  }
});
