import { defineConfig } from "@effect/graphql-generator/Config";

// Public schema: https://docs.github.com/public/fpt/schema.docs.graphql. Enterprise Server validates a
// whole document before @include, so fields it lacks belong in separate github.com-only documents.
export default defineConfig({
  schema: "./schema/github.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    GitObjectID: "effect/Schema#String",
    GitRefname: "effect/Schema#String",
    // Preserve GitHub's strings for comparison with other reads.
    DateTime: "effect/Schema#String",
  },
});
