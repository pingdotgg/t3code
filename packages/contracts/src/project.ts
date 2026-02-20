import { z } from "zod";

export const PROJECT_SCRIPT_ICON_VALUES = [
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
] as const;

export const projectScriptIconSchema = z.enum(PROJECT_SCRIPT_ICON_VALUES);

export const projectScriptSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().trim().min(1).max(64),
    command: z.string().trim().min(1).max(10_000),
    icon: projectScriptIconSchema,
    runOnWorktreeCreate: z.boolean().default(false),
  })
  .strict();

export const projectScriptsSchema = z.array(projectScriptSchema).max(64);

export const projectRecordSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().min(1),
  scripts: projectScriptsSchema.default([]),
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

export const projectUpdateScriptsInputSchema = z.object({
  id: z.string().min(1),
  scripts: projectScriptsSchema,
});

export const projectUpdateScriptsResultSchema = z.object({
  project: projectRecordSchema,
});

export type ProjectScriptIcon = z.infer<typeof projectScriptIconSchema>;
export type ProjectScript = z.infer<typeof projectScriptSchema>;

/**
 * Deduplicate scripts by ID and enforce at most one `runOnWorktreeCreate: true`
 * flag (the first one wins). Fields are trimmed defensively so this is safe to
 * call on data that hasn't been through Zod parsing.
 */
export function normalizeProjectScripts(scripts: readonly ProjectScript[]): ProjectScript[] {
  const seenIds = new Set<string>();
  const deduped: ProjectScript[] = [];
  for (const script of scripts) {
    const id = script.id.trim();
    if (id.length === 0 || seenIds.has(id)) continue;
    seenIds.add(id);
    deduped.push({
      ...script,
      id,
      name: script.name.trim(),
      command: script.command.trim(),
    });
  }

  let setupAssigned = false;
  const normalized: ProjectScript[] = [];
  for (const script of deduped) {
    if (!script.runOnWorktreeCreate) {
      normalized.push(script);
      continue;
    }
    if (!setupAssigned) {
      setupAssigned = true;
      normalized.push(script);
      continue;
    }
    normalized.push({ ...script, runOnWorktreeCreate: false });
  }
  return normalized;
}
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ProjectListResult = z.infer<typeof projectListResultSchema>;
export type ProjectAddInput = z.input<typeof projectAddInputSchema>;
export type ProjectAddResult = z.infer<typeof projectAddResultSchema>;
export type ProjectRemoveInput = z.input<typeof projectRemoveInputSchema>;
export type ProjectSearchEntriesInput = z.input<typeof projectSearchEntriesInputSchema>;
export type ProjectEntryKind = z.infer<typeof projectEntryKindSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type ProjectSearchEntriesResult = z.infer<typeof projectSearchEntriesResultSchema>;
export type ProjectUpdateScriptsInput = z.input<typeof projectUpdateScriptsInputSchema>;
export type ProjectUpdateScriptsResult = z.infer<typeof projectUpdateScriptsResultSchema>;
