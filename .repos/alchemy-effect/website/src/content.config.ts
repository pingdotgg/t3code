import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { defineCollection, z } from "astro:content";
import { blogSchema } from "starlight-blog/schema";

export const blogCategories = ["release", "post"] as const;
export type BlogCategory = (typeof blogCategories)[number];

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: (ctx) =>
        blogSchema(ctx).extend({
          category: z.enum(blogCategories).optional(),
        }),
    }),
  }),
  // The site is English-only, but Starlight always reads this collection for
  // UI strings and Astro 7 warns when it is missing or empty. One empty entry
  // keeps Starlight's built-in strings without a src/content/i18n directory.
  i18n: defineCollection({ loader: () => [{ id: "en" }], schema: i18nSchema() }),
};
