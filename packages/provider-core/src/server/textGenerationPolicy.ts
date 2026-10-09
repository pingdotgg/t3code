import * as Schema from "effect/Schema";

export const TextGenerationPolicyKind = Schema.Literals([
  "default",
  "conventional_commits",
  "repo_conventions",
  "custom",
]);
export type TextGenerationPolicyKind = typeof TextGenerationPolicyKind.Type;

export const TextGenerationPolicy = Schema.Struct({
  kind: TextGenerationPolicyKind,
  commitInstructions: Schema.optional(Schema.String),
  changeRequestInstructions: Schema.optional(Schema.String),
  branchInstructions: Schema.optional(Schema.String),
  threadTitleInstructions: Schema.optional(Schema.String),
  inferRepositoryConventions: Schema.Boolean,
});
export type TextGenerationPolicy = typeof TextGenerationPolicy.Type;
