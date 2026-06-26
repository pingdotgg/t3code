import type { WorkflowRef } from "./t3work-sdk.types.ts";

export type RecipeTechnicalDepth = "low" | "medium" | "high";
export type RecipeBrevity = "short" | "balanced" | "detailed";
export type RecipeGuidanceStyle = "guided" | "balanced" | "expert";
export type RecipeDetailDensity = "guided" | "balanced" | "expert";

export interface RecipeApplicabilitySpec {
  readonly resourceKinds?: ReadonlyArray<string>;
  readonly projectSourceKinds?: ReadonlyArray<string>;
  readonly requiresIntegration?: ReadonlyArray<string>;
  readonly jiraIssueTypes?: ReadonlyArray<string>;
  readonly requiredSkillPackIds?: ReadonlyArray<string>;
  readonly technicalDepths?: ReadonlyArray<RecipeTechnicalDepth>;
  readonly brevities?: ReadonlyArray<RecipeBrevity>;
  readonly guidanceStyles?: ReadonlyArray<RecipeGuidanceStyle>;
  readonly detailDensities?: ReadonlyArray<RecipeDetailDensity>;
}

export interface RecipeRef<Inputs = unknown, Outputs = unknown> {
  readonly kind: "recipe";
  readonly id: string;
  readonly version: string;
  readonly scope: "project";
  readonly title: string;
  readonly shortDescription: string;
  readonly surfaces: ReadonlyArray<string>;
  readonly icon?: string;
  readonly rank?: number;
  readonly appliesTo?: RecipeApplicabilitySpec;
  readonly allowedToolGroups?: ReadonlyArray<string>;
  readonly slashAlias?: string;
  readonly defaultAction: WorkflowRef<Inputs, Outputs>;
  readonly defaults?: Partial<Inputs>;
  readonly Inputs?: Inputs;
  readonly Outputs?: Outputs;
}

export type AnyRecipeRef = RecipeRef<unknown, unknown>;
