import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/posts" }),
  schema: z.object({
    title: z.string(),
  }),
});

export const collections = { posts };
