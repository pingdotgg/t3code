import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";

import { docsEntryId } from "./lib/docsLinks";

// The user guides stay in the repo's docs/user so they remain readable on GitHub.
export const collections = {
  docs: defineCollection({
    loader: glob({
      pattern: "*.md",
      base: "../../docs/user",
      generateId: ({ entry }) => docsEntryId(entry),
    }),
    schema: docsSchema(),
  }),
};
