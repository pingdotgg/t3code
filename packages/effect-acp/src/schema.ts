import * as Schema from "effect/Schema";
import * as Generated from "./_generated/schema.gen.ts";

export * from "./_generated/schema.gen.ts";
export * from "./_generated/meta.gen.ts";

// Agents already use additionalDirectories; preserve it until the generated ACP schema includes it.
const additionalDirectories = Schema.optionalKey(Schema.Array(Schema.String));
export const NewSessionRequest = Schema.Struct({
  ...Generated.NewSessionRequest.fields,
  additionalDirectories,
});
export type NewSessionRequest = typeof NewSessionRequest.Type;
export const LoadSessionRequest = Schema.Struct({
  ...Generated.LoadSessionRequest.fields,
  additionalDirectories,
});
export type LoadSessionRequest = typeof LoadSessionRequest.Type;
export const ResumeSessionRequest = Schema.Struct({
  ...Generated.ResumeSessionRequest.fields,
  additionalDirectories,
});
export type ResumeSessionRequest = typeof ResumeSessionRequest.Type;
