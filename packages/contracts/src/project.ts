import { z } from "zod";

export const projectRecordSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectListResultSchema = z.array(projectRecordSchema);

export const projectAddInputSchema = z.object({
  cwd: z.string().trim().min(1),
});

export const projectAddResultSchema = z.object({
  project: projectRecordSchema,
  created: z.boolean(),
});

export const projectRemoveInputSchema = z.object({
  id: z.string().min(1),
});

export const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;

export const projectSearchEntriesInputSchema = z.object({
  cwd: z.string().trim().min(1),
  query: z.string().trim().max(256).default(""),
  limit: z.number().int().min(1).max(PROJECT_SEARCH_ENTRIES_MAX_LIMIT).default(80),
});

export const projectEntryKindSchema = z.enum(["file", "directory"]);

export const projectEntrySchema = z.object({
  path: z.string().min(1),
  kind: projectEntryKindSchema,
  parentPath: z.string().optional(),
});

export const projectSearchEntriesResultSchema = z.object({
  entries: z.array(projectEntrySchema),
  truncated: z.boolean(),
});

export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ProjectListResult = z.infer<typeof projectListResultSchema>;
export type ProjectAddInput = z.input<typeof projectAddInputSchema>;
export type ProjectAddResult = z.infer<typeof projectAddResultSchema>;
export type ProjectRemoveInput = z.input<typeof projectRemoveInputSchema>;
export type ProjectSearchEntriesInput = z.input<typeof projectSearchEntriesInputSchema>;
export type ProjectEntryKind = z.infer<typeof projectEntryKindSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type ProjectSearchEntriesResult = z.infer<typeof projectSearchEntriesResultSchema>;
