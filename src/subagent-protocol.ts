import { z } from "zod";

export const SubagentRun = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  agent: z.string().min(1),
  cwd: z.string().min(1),
  sessionFile: z.string().min(1),
  autoExit: z.boolean(),
  createdAt: z.number(),
});
export type SubagentRun = z.infer<typeof SubagentRun>;

export const SubagentStatus = z.strictObject({
  id: z.string().min(1),
  state: z.enum(["starting", "active", "waiting", "done", "error", "help"]),
  updatedAt: z.number(),
});

export const SubagentResult = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["done", "error", "help"]),
  summary: z.string(),
  sessionFile: z.string().min(1),
  updatedAt: z.number(),
});
export type SubagentResult = z.infer<typeof SubagentResult>;
