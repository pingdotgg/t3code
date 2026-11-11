import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Built-in starter team templates, inspired by OpenRig's Workshop/Starter/Factory
 * topologies: durable specialist seats (lead, builder, QA, reviewer) launched as
 * ordinary top-level threads in one project.
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
        "You are the Workshop lead. Own the outcome: clarify goals with the user, break work into seats, coordinate Builder / QA / Reviewer, and bring decisions back. Prefer delegating specialist work over doing it yourself.",
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

export const OrchestrationV2LaunchTeamTemplateInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  templateId: TeamTemplateId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Pin each seat in the project sidebar. Defaults to true. */
  pin: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2LaunchTeamTemplateInput =
  typeof OrchestrationV2LaunchTeamTemplateInput.Type;

export const OrchestrationV2LaunchedTeamSeat = Schema.Struct({
  seatId: TeamTemplateSeatId,
  title: TrimmedNonEmptyString,
  roleBrief: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type OrchestrationV2LaunchedTeamSeat = typeof OrchestrationV2LaunchedTeamSeat.Type;

export const OrchestrationV2LaunchTeamTemplateResult = Schema.Struct({
  templateId: TeamTemplateId,
  seats: Schema.NonEmptyArray(OrchestrationV2LaunchedTeamSeat),
});
export type OrchestrationV2LaunchTeamTemplateResult =
  typeof OrchestrationV2LaunchTeamTemplateResult.Type;

export class OrchestrationV2LaunchTeamTemplateError extends Schema.TaggedError<OrchestrationV2LaunchTeamTemplateError>()(
  "OrchestrationV2LaunchTeamTemplateError",
  {
    commandId: CommandId,
    projectId: ProjectId,
    templateId: TeamTemplateId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
