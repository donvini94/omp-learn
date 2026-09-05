import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { LearnConfig } from "./config";

const ImageNode = z.object({ t: z.literal("Image"), c: z.tuple([z.unknown(), z.unknown(), z.tuple([z.string(), z.string()])]) });
const Document = z.object({ "pandoc-api-version": z.array(z.number()), meta: z.record(z.string(), z.unknown()), blocks: z.array(z.unknown()) });

function pandoc(config: LearnConfig, input: string, args: string[]): Promise<string> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<string>();
  const child = execFile(config.pandoc, args, { cwd: config.learningDir, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Pandoc lesson conversion failed: ${stderr || error.message}`));
    else resolveResult(stdout);
  });
  child.stdin?.on("error", reject);
  child.stdin?.end(input);
  return promise;
}

function prepareImages(node: unknown, config: LearnConfig, target: string): unknown {
  if (Array.isArray(node)) return node.map(item => prepareImages(item, config, target));
  if (!node || typeof node !== "object") return node;
  const image = ImageNode.safeParse(node);
  if (image.success) {
    const [attributes, caption, [source, title]] = image.data.c;
    if (/^https?:\/\//i.test(source)) {
      // Remote references remain links: reading a lesson must not fetch tracking images.
      return { t: "Link", c: [attributes, caption, [source, title]] };
    }
    const absolute = realpathSync(source.startsWith("file://") ? fileURLToPath(source) : resolve(config.learningDir, source));
    const inRoot = relative(config.learningDir, absolute);
    if (inRoot === ".." || inRoot.startsWith(`..${sep}`) || isAbsolute(inRoot)) {
      throw new Error("Lesson images must be published inside the learning directory");
    }
    return { t: "Image", c: [attributes, [], [relative(dirname(target), absolute).split(sep).join("/"), title]] };
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, prepareImages(value, config, target)]));
}

export async function markdownToOrg(config: LearnConfig, markdown: string, target: string, headingDepth = 1): Promise<string> {
  const json = await pandoc(config, markdown, ["--from=markdown+tex_math_dollars-raw_attribute-raw_html", "--to=json"]);
  const document = Document.parse(JSON.parse(json));
  const prepared = prepareImages(document, config, target);
  return (await pandoc(config, JSON.stringify(prepared), ["--from=json", "--to=org", "--wrap=none", `--shift-heading-level-by=${headingDepth}`])).trim();
}

export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

export function orgFileLink(file: string, from: string, label: string): string {
  const path = relative(dirname(from), file).split(sep).join("/").replace(/\[/g, "%5B").replace(/\]/g, "%5D");
  return `[[file:${path}][${oneLine(label).replace(/[\[\]]/g, "")}]]`;
}
