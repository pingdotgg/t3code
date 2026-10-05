import { defineConfig } from "@coderabbitai/config";

export default defineConfig({
  reviews: {
    high_level_summary: false,
    review_status: false,
    auto_review: {
      enabled: true,
    },
    path_filters: [
      // Vendored read-only reference checkouts of upstream Effect and Alchemy
      // (see scripts/lib/reference-repos.ts). Nothing imports from them.
      "!.repos/**",
    ],
  },
});
