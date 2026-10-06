/**
 * The slice of the extension API that the shared learning modules use, which OMP and Pi both
 * provide. Typing against either harness's ExtensionAPI would reject the other's call sites.
 *
 * CEILING: handler, tool and context parameters are `any` at this boundary. Each harness's own
 * type-checked entry (`index.ts`, `pi-index.ts`) is the only place their precise types are
 * visible. The upgrade path is a generated per-harness adapter once the two APIs converge.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface HarnessTool {
  name: string;
  label?: string;
  description?: string;
  parameters: unknown;
  execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any): unknown;
  renderCall?(args: any, theme: any, ...rest: any[]): unknown;
  renderResult?(result: any, options: any, theme: any, ...rest: any[]): unknown;
  [extra: string]: unknown;
}

export interface HarnessApi {
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: any): unknown }): unknown;
  registerTool(tool: HarnessTool): unknown;
  appendEntry(customType: string, data?: unknown): unknown;
  sendUserMessage(content: string): void;
}
