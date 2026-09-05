import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAccess, evaluateToolCall } from "../src/access";

let root: string;
let learning: string;
let access: ContextAccess;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-learn-access-")));
  learning = join(root, "learning");
  mkdirSync(learning);
  writeFileSync(join(learning, "lesson.org"), "Shared learner attempt.");
  writeFileSync(join(root, "source.org"), "Explicitly supplied source.");
  writeFileSync(join(root, "unrelated.org"), "Unrelated private note.");
  writeFileSync(join(root, "anki.org"), "Existing Anki cards.");
  access = new ContextAccess({ learningDir: learning, ankiFile: join(root, "anki.org"), ankiDeck: "Default", ankiHeading: "Dispatch Shelf", emacsclient: "emacsclient", pandoc: "pandoc" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function readContext(file: string): string {
  access.assertPath(file, learning);
  return readFileSync(file, "utf8");
}

test("automatic context stays shared and explicit grants authorize exactly one file", () => {
  expect(readContext(join(learning, "lesson.org"))).toBe("Shared learner attempt.");
  expect(() => readContext(join(root, "source.org"))).toThrow(Error);
  access.permit(join(root, "source.org"), learning);
  expect(readContext(join(root, "source.org"))).toBe("Explicitly supplied source.");
  expect(() => readContext(join(root, "unrelated.org"))).toThrow(Error);
  expect(() => access.assertPath(root, learning)).toThrow(Error);
  expect(() => access.assertPath(join(root, "source.org"), learning, true)).toThrow(Error);
});

test("symlinks and wildcard traversal cannot open unrelated notes", () => {
  symlinkSync(join(root, "unrelated.org"), join(learning, "linked.org"));
  expect(() => readContext(join(learning, "linked.org"))).toThrow(Error);
  expect(() => access.assertPath("{.,../}/**/*.org", learning, false, true)).toThrow(Error);
  expect(() => access.assertPath(`${learning};${root}`, learning, false, true)).toThrow(Error);
});

test("the configured Anki file stays export-only even with an explicit grant attempt", () => {
  expect(() => readContext(join(root, "anki.org"))).toThrow(Error);
  expect(() => access.permit(join(root, "anki.org"), learning)).toThrow(Error);
});

test("device dispatches reach mounted tools while keeping their own policy", () => {
  const verdict = (tool: string, input: object) => evaluateToolCall(access, tool, input, learning);
  // The teacher's quiz is only reachable through the xd:// transport when it is
  // demoted to a device; blocking the URL blocked every graded question.
  expect(verdict("write", { path: "xd://quiz", content: '{"question":"q"}' })).toBeUndefined();
  expect(verdict("read", { path: "xd://quiz" })).toBeUndefined();
  // Policy still follows the tool the device actually runs.
  expect(verdict("write", { path: "xd://recall", content: '{"query":"him"}' })?.block).toBe(true);
  expect(verdict("write", { path: "xd://ast_edit", content: JSON.stringify({ ops: [], paths: [join(root, "unrelated.org")] }) })?.block).toBe(true);
  expect(verdict("write", { path: "xd://ast_edit", content: JSON.stringify({ ops: [], paths: [join(learning, "lesson.org")] }) })).toBeUndefined();
  // Non-device schemes and unrelated notes stay out.
  expect(verdict("read", { path: "ssh://box/etc/passwd" })?.block).toBe(true);
  expect(verdict("read", { path: join(root, "unrelated.org") })?.block).toBe(true);
  expect(verdict("recall", { query: "him" })?.block).toBe(true);
});
