import { defineConfig } from "@effect/graphql-generator/Config";

export default defineConfig({
  schema: "./schema/linear.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    DateTime: "effect/Schema#String",
    JSONObject: "./src/server/linearGraphQlScalars.ts#JSONObject",
  },
});
