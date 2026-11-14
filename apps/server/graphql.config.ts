import { defineConfig } from "@effect/graphql-generator/Config";

// `schema/expo.graphql` is api.expo.dev's schema, read by introspection
// (`vp run generate:expo-schema`). The EAS Simulator operations are the ones
// eas-cli's `simulator:*` commands send; Expo does not document them.
export default defineConfig({
  schema: "./schema/expo.graphql",
  documents: ["src/device/**/*.graphql"],
  scalars: {
    // Feature gates arrive as an object of gate name to boolean.
    JSONObject: "effect/Schema#Json",
  },
});
