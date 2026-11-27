import {
  customOrchestrationCommandNameProblem,
  type CustomOrchestrationCommand,
  type CustomOrchestrationModel,
  type CustomOrchestrationSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { resolveCustomOrchestrationModel } from "@t3tools/shared/customOrchestration";

import {
  describeCustomOrchestrationProblem,
  type CustomOrchestrationAvailability,
} from "./customOrchestrationModels.ts";

const COMMAND = /^\s*\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/u;

export interface CustomOrchestrationTurn {
  /** The model this turn runs on: the orchestrator, or a fallback of it. */
  readonly running: ModelSelection;
  readonly problemOf: CustomOrchestrationAvailability;
}

/** The `delegate_task` target that runs exactly the configured model. */
const target = (selection: ModelSelection) =>
  JSON.stringify({
    providerInstanceId: selection.instanceId,
    model: selection.model,
    // Always given: omitted options are inherited from the orchestrator's own model.
    options: selection.options ?? [],
  });

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The targets that can run one configured model's work now, in the order to try them. */
function targets(
  entry: CustomOrchestrationModel,
  turn: CustomOrchestrationTurn,
  ifNone: string,
): string {
  const { usable, skipped } = resolveCustomOrchestrationModel(entry, turn.problemOf);
  const unavailable = skipped
    .map((item) => `${item.selection.model} (${describeCustomOrchestrationProblem(item.problem)})`)
    .join(", ");
  if (usable.length === 0) return `no configured model can run: ${unavailable}. ${ifNone}`;
  const list = usable.map(target).join(" then ");
  return skipped[0]?.selection === entry.modelSelection
    ? `${list}. Unavailable now: ${unavailable}. Tell the user that a fallback is standing in.`
    : list;
}

function orchestratorNote(
  settings: CustomOrchestrationSettings,
  { running, problemOf }: CustomOrchestrationTurn,
): ReadonlyArray<string> {
  const primary = settings.orchestrator?.modelSelection;
  if (
    primary === undefined ||
    (primary.instanceId === running.instanceId && primary.model === running.model)
  ) {
    return [];
  }
  const problem = problemOf(primary);
  return problem === null
    ? []
    : [
        `Their orchestrator model ${primary.model} cannot run now because ${describeCustomOrchestrationProblem(problem)}, so you are running as its fallback ${running.model}. Tell the user in one line, unless you already have.`,
      ];
}

const NEXT_TARGET =
  "If delegate_task refuses a target, or its task fails on a usage limit or an unavailable provider or model, tell the user which and why, then try the next target listed";

/**
 * What each turn of a Custom Orchestration thread carries after the user's words, read from
 * settings as the turn starts so edits apply to the next one.
 */
export function customOrchestrationInstructions(
  settings: CustomOrchestrationSettings,
  turn: CustomOrchestrationTurn,
): string {
  const tasks =
    settings.tasks.length === 0
      ? []
      : [
          "Task kinds. When work is one of these, delegate it with the T3 Code `delegate_task` tool using exactly the first target listed for it, even on your own provider: these are settings the user asked for, so a native subagent does not count.",
          ...settings.tasks.map((task) => {
            const when = oneLine(task.description);
            return `- ${oneLine(task.name)}${when === "" ? "" : ` (${when})`}: ${targets(task, turn, "If this work comes up, tell the user and skip it.")}`;
          }),
          "Do other work yourself, as you normally would.",
          `${NEXT_TARGET} for that kind. When none is left, tell the user and skip that piece. Never use a model that is not listed for the kind. If delegate_task is missing, say so and skip that piece.`,
        ];
  return [
    "<t3_code_custom_orchestration>",
    "The user chose Custom Orchestration: you are the orchestrator. Apply their settings below without being asked.",
    ...orchestratorNote(settings, turn),
    ...tasks,
    "A plain request for a review is not a task kind: use your own harness's review command or skill, or review it yourself if it has none, and delegate nothing for it.",
    "</t3_code_custom_orchestration>",
  ].join("\n");
}

function commandPrompt(
  command: CustomOrchestrationCommand,
  request: string,
  settings: CustomOrchestrationSettings,
  turn: CustomOrchestrationTurn,
): string {
  const instructions = command.instructions.trim();
  return [
    "<t3_code_custom_orchestration>",
    `The user ran /${command.name}, one of their Custom Orchestration review commands.`,
    ...orchestratorNote(settings, turn),
    "1. Work out what is to be reviewed (without a request below, the current work in this thread). Call the T3 Code `delegate_task` tool once for each reviewer below, with role `review`, exactly its first target, and the same self-contained brief. Reviewers work independently: tell none of them what another found.",
    ...command.reviewers.map(
      (reviewer) => `- ${targets(reviewer, turn, "Go on without this reviewer.")}`,
    ),
    "2. After every reviewer has finished, check each finding against the source yourself, drop those that do not hold, and report one merged list that says which reviewers raised each, naming the model that actually ran.",
    `${NEXT_TARGET} for that reviewer. When none is left, go on without that reviewer. Never use a model that is not listed for the reviewer, or a native subagent. If delegate_task is missing or no reviewer can run, say so and stop.`,
    ...(instructions === "" ? [] : ["The user's instructions for this command:", instructions]),
    "</t3_code_custom_orchestration>",
    ...(request === "" ? [] : ["", request]),
  ].join("\n");
}

/** The prompt a typed custom command stands for, or undefined when the text is not one. */
export function expandCustomOrchestrationCommand(
  text: string,
  settings: CustomOrchestrationSettings,
  turn: CustomOrchestrationTurn,
): string | undefined {
  const match = COMMAND.exec(text);
  if (match === null) return undefined;
  const command = settings.commands.find(
    (candidate) =>
      candidate.name === match[1] &&
      candidate.reviewers.length > 0 &&
      // A hand-edited settings file must not shadow the harness's own commands.
      customOrchestrationCommandNameProblem(candidate.name) === null,
  );
  return command === undefined
    ? undefined
    : commandPrompt(command, (match[2] ?? "").trim(), settings, turn);
}
