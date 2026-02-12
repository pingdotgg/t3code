import { z } from "zod";

const terminalColsSchema = z.number().int().min(20).max(400);
const terminalRowsSchema = z.number().int().min(5).max(200);

export const terminalThreadInputSchema = z.object({
  threadId: z.string().trim().min(1),
});

export const terminalOpenInputSchema = terminalThreadInputSchema.extend({
  cwd: z.string().trim().min(1),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});

export const terminalWriteInputSchema = terminalThreadInputSchema.extend({
  data: z.string().min(1).max(65_536),
});

export const terminalResizeInputSchema = terminalThreadInputSchema.extend({
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});

export const terminalCloseInputSchema = terminalThreadInputSchema.extend({
  deleteHistory: z.boolean().optional(),
});

export const terminalSessionStatusSchema = z.enum([
  "starting",
  "running",
  "exited",
  "error",
]);

export const terminalSessionSnapshotSchema = z.object({
  threadId: z.string().min(1),
  cwd: z.string().min(1),
  status: terminalSessionStatusSchema,
  pid: z.number().int().positive().nullable(),
  history: z.string(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  updatedAt: z.string().datetime(),
});

const terminalEventBaseSchema = z.object({
  threadId: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const terminalStartedEventSchema = terminalEventBaseSchema.extend({
  type: z.literal("started"),
  snapshot: terminalSessionSnapshotSchema,
});

export const terminalOutputEventSchema = terminalEventBaseSchema.extend({
  type: z.literal("output"),
  data: z.string(),
});

export const terminalExitedEventSchema = terminalEventBaseSchema.extend({
  type: z.literal("exited"),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
});

export const terminalErrorEventSchema = terminalEventBaseSchema.extend({
  type: z.literal("error"),
  message: z.string().min(1),
});

export const terminalClearedEventSchema = terminalEventBaseSchema.extend({
  type: z.literal("cleared"),
});

export const terminalRestartedEventSchema = terminalEventBaseSchema.extend({
  type: z.literal("restarted"),
  snapshot: terminalSessionSnapshotSchema,
});

export const terminalEventSchema = z.discriminatedUnion("type", [
  terminalStartedEventSchema,
  terminalOutputEventSchema,
  terminalExitedEventSchema,
  terminalErrorEventSchema,
  terminalClearedEventSchema,
  terminalRestartedEventSchema,
]);

export type TerminalThreadInput = z.input<typeof terminalThreadInputSchema>;
export type TerminalOpenInput = z.input<typeof terminalOpenInputSchema>;
export type TerminalWriteInput = z.input<typeof terminalWriteInputSchema>;
export type TerminalResizeInput = z.input<typeof terminalResizeInputSchema>;
export type TerminalCloseInput = z.input<typeof terminalCloseInputSchema>;
export type TerminalSessionStatus = z.infer<typeof terminalSessionStatusSchema>;
export type TerminalSessionSnapshot = z.infer<typeof terminalSessionSnapshotSchema>;
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
