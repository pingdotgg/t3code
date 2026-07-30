import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
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
};
