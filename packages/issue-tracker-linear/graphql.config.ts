import { defineConfig } from "@effect/graphql-generator/Config";

// `schema/linear.graphql` is the public schema Linear publishes with its SDK
// (https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
export default defineConfig({
  schema: "./schema/linear.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    // Kept as Linear sends it: the tracker passes these on as ISO strings.
    DateTime: "effect/Schema#String",
    // An attachment's metadata arrives as an object; its shape depends on the integration.
    JSONObject: "effect/Schema#Json",
    // Documented as stringified JSON, but a template's data has also arrived as an object.
    JSON: "effect/Schema#Json",
    // Filters compare dates with these; the tracker sends none of them.
    DateTimeOrDuration: "effect/Schema#String",
    Duration: "effect/Schema#String",
    TimelessDate: "effect/Schema#String",
    TimelessDateOrDuration: "effect/Schema#String",
  },
});
