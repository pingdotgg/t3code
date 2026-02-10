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

export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ProjectListResult = z.infer<typeof projectListResultSchema>;
export type ProjectAddInput = z.input<typeof projectAddInputSchema>;
export type ProjectAddResult = z.infer<typeof projectAddResultSchema>;
export type ProjectRemoveInput = z.input<typeof projectRemoveInputSchema>;
