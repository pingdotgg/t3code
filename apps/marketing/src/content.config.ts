import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const library = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/library" }),
  schema: z.object({
    /** The H1. The page title adds " | T3 Code". */
    title: z.string().max(70),
    /** Meta description and lede. */
    description: z.string().min(110).max(165),
    /** ISO date of the last factual review. */
    updated: z.coerce.date(),
    /** Where each claim on the page comes from: repository docs, source files, or video timestamps. */
    sources: z.array(z.object({ label: z.string(), url: z.url() })).min(1),
    faq: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
    video: z
      .object({
        id: z.string(),
        title: z.string(),
        durationSeconds: z.number().int().positive(),
        uploadDate: z.string().optional(),
        chapters: z.array(
          z.object({ time: z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/), label: z.string() }),
        ),
      })
      .optional(),
  }),
});

export const collections = { library };
