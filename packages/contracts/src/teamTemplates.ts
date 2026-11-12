import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ContributorBundleOrientation } from "./contributorBundle.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import {
  ThreadSpecialist,
  ThreadSpecialistInstructions,
  ThreadSpecialistKey,
  ThreadSpecialistLabel,
} from "./threadSpecialist.ts";

/**
 * Built-in starter specialist templates, inspired by OpenRig's Workshop topology.
 * Recipe seats become durable {@link ThreadSpecialist} bindings when added.
 * Repo checkouts can also ship `t3.contributor-bundle.json` through the same action.
 */
export const TeamTemplateId = Schema.Literals(["workshop"]);
export type TeamTemplateId = typeof TeamTemplateId.Type;

export const TeamTemplateSeatId = Schema.Literals(["lead", "builder", "qa", "reviewer"]);
export type TeamTemplateSeatId = typeof TeamTemplateSeatId.Type;

export const TeamTemplateSeat = Schema.Struct({
  id: TeamTemplateSeatId,
  title: TrimmedNonEmptyString,
  roleBrief: TrimmedNonEmptyString,
});
export type TeamTemplateSeat = typeof TeamTemplateSeat.Type;

export const TeamTemplateDefinition = Schema.Struct({
  id: TeamTemplateId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  seats: Schema.NonEmptyArray(TeamTemplateSeat),
});
export type TeamTemplateDefinition = typeof TeamTemplateDefinition.Type;

export const WORKSHOP_TEAM_TEMPLATE = {
  id: "workshop" as const,
  name: "Workshop",
  description:
    "A lead, builder, QA, and reviewer for ongoing work in one repository. Talk to the lead; specialists stay durable for follow-up.",
  seats: [
    {
      id: "lead" as const,
      title: "Workshop · Lead",
      roleBrief:
        "You are the Workshop lead. Own the outcome: clarify goals with the user, break work into specialists, coordinate Builder / QA / Reviewer, and bring decisions back. Prefer delegating specialist work over doing it yourself.",
    },
    {
      id: "builder" as const,
      title: "Workshop · Builder",
      roleBrief:
        "You are the Workshop builder. Implement assigned changes in this repository. Keep scope tight, leave the tree reviewable, and report what changed when done.",
    },
    {
      id: "qa" as const,
      title: "Workshop · QA",
      roleBrief:
        "You are Workshop QA. Exercise the user paths the change touches. Prefer failing reproduction steps and concrete verification over abstract review.",
    },
    {
      id: "reviewer" as const,
      title: "Workshop · Reviewer",
      roleBrief:
        "You are the Workshop reviewer. Independently review the implementation for correctness, regressions, and clarity. Do not re-implement; report findings.",
    },
  ],
} as const satisfies TeamTemplateDefinition;

export const STARTER_TEAM_TEMPLATES = [WORKSHOP_TEAM_TEMPLATE] as const;

export function teamTemplateById(id: TeamTemplateId): TeamTemplateDefinition {
  const template = STARTER_TEAM_TEMPLATES.find((entry) => entry.id === id);
  if (template === undefined) {
    throw new Error(`Unknown team template: ${id}`);
  }
  return template;
}

export function formatWorkshopLeadPrompt(
  template: TeamTemplateDefinition = WORKSHOP_TEAM_TEMPLATE,
): string {
  const specialists = template.seats.filter((seat) => seat.id !== "lead");
  return [
    "You are the Workshop lead for this repository.",
    "Specialists:",
    ...specialists.map((seat) => `- ${seat.title} (\`${seat.id}\`): ${seat.roleBrief}`),
    "",
    "Ask what outcome I want, then coordinate Builder / QA / Reviewer. Prefer delegating specialist work over doing it yourself.",
  ].join("\n");
}

/** Where the specialist recipe comes from for the one add-from-template action. */
export const SpecialistTemplateSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("builtin"),
    templateId: TeamTemplateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("contributor-bundle"),
  }),
]);
export type SpecialistTemplateSource = typeof SpecialistTemplateSource.Type;

export const OrchestrationV2SpecialistTemplatePreviewSeat = Schema.Struct({
  key: ThreadSpecialistKey,
  label: ThreadSpecialistLabel,
  instructions: ThreadSpecialistInstructions,
  title: TrimmedNonEmptyString,
  /** When set, this specialist key is already bound in the project. */
  existingThreadId: Schema.optional(ThreadId),
});
export type OrchestrationV2SpecialistTemplatePreviewSeat =
  typeof OrchestrationV2SpecialistTemplatePreviewSeat.Type;

export const OrchestrationV2PreviewSpecialistTemplateInput = Schema.Struct({
  projectId: ProjectId,
  source: SpecialistTemplateSource,
});
export type OrchestrationV2PreviewSpecialistTemplateInput =
  typeof OrchestrationV2PreviewSpecialistTemplateInput.Type;

export const OrchestrationV2PreviewSpecialistTemplateResult = Schema.Struct({
  source: SpecialistTemplateSource,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  orientation: Schema.optional(ContributorBundleOrientation),
  leadPrompt: TrimmedNonEmptyString,
  specialists: Schema.NonEmptyArray(OrchestrationV2SpecialistTemplatePreviewSeat),
});
export type OrchestrationV2PreviewSpecialistTemplateResult =
  typeof OrchestrationV2PreviewSpecialistTemplateResult.Type;

export class OrchestrationV2PreviewSpecialistTemplateError extends Schema.TaggedError<OrchestrationV2PreviewSpecialistTemplateError>()(
  "OrchestrationV2PreviewSpecialistTemplateError",
  {
    projectId: ProjectId,
    source: SpecialistTemplateSource,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OrchestrationV2AddSpecialistsFromTemplateInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  source: SpecialistTemplateSource,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Pin each specialist in the project sidebar. Defaults to true. */
  pin: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2AddSpecialistsFromTemplateInput =
  typeof OrchestrationV2AddSpecialistsFromTemplateInput.Type;

export const OrchestrationV2AddedSpecialist = Schema.Struct({
  specialist: ThreadSpecialist,
  title: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type OrchestrationV2AddedSpecialist = typeof OrchestrationV2AddedSpecialist.Type;

export const OrchestrationV2AddSpecialistsFromTemplateResult = Schema.Struct({
  source: SpecialistTemplateSource,
  name: TrimmedNonEmptyString,
  leadPrompt: TrimmedNonEmptyString,
  specialists: Schema.NonEmptyArray(OrchestrationV2AddedSpecialist),
});
export type OrchestrationV2AddSpecialistsFromTemplateResult =
  typeof OrchestrationV2AddSpecialistsFromTemplateResult.Type;

export class OrchestrationV2AddSpecialistsFromTemplateError extends Schema.TaggedError<OrchestrationV2AddSpecialistsFromTemplateError>()(
  "OrchestrationV2AddSpecialistsFromTemplateError",
  {
    commandId: CommandId,
    projectId: ProjectId,
    source: SpecialistTemplateSource,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
