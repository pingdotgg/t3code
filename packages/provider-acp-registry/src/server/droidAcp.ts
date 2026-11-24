import {
  type OrchestrationV2UserInputQuestion,
  type RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type {
  AcpAdapterV2Flavor,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// Droid's autonomy levels are its permission modes: `normal` only auto-approves reads,
// `auto-low` adds file edits, and each higher level approves more of what T3 would ask about.
const DROID_MODE_BY_RUNTIME_MODE: Record<RuntimeMode, string> = {
  "approval-required": "normal",
  "auto-accept-edits": "auto-low",
  auto: "auto-medium",
  "full-access": "auto-high",
};

export function droidSessionMode(runtimeMode: RuntimeMode): string {
  return DROID_MODE_BY_RUNTIME_MODE[runtimeMode];
}

/** The runtime mode a Droid autonomy level grants; the inverse of `droidSessionMode`. */
export function droidRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  switch (modeId) {
    case "normal":
    // `spec` builds a feature spec read-only, so it grants no more than asking first.
    case "spec":
      return "approval-required";
    case "auto-low":
      return "auto-accept-edits";
    case "auto-medium":
      return "auto";
    case "auto-high":
      return "full-access";
    default:
      return undefined;
  }
}

const decodeDroidTaskInput = Schema.decodeUnknownOption(
  Schema.Struct({
    prompt: Schema.String,
    description: Schema.optionalKey(Schema.String),
    subagent_type: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
  }),
);

function droidTaskOutputText(tool: AcpToolCallState): string | null {
  const rawOutput = tool.data.rawOutput;
  const text =
    typeof rawOutput === "string"
      ? rawOutput
      : Predicate.isObject(rawOutput) && typeof rawOutput.text === "string"
        ? rawOutput.text
        : undefined;
  return text === undefined || text.trim().length === 0 ? null : text;
}

/**
 * Droid runs workers and subagents through its `Task` tool. The call reports
 * `subagent_type` and the prompt up front, then settles to `completed` with the worker's
 * result even after the prompt that launched it has ended.
 */
export function extractDroidSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== "Task") return undefined;
  const input = decodeDroidTaskInput(tool.data.rawInput);
  const result = droidTaskOutputText(tool);
  const status: AcpAdapterV2SubagentUpdate["status"] =
    tool.status === "failed"
      ? "failed"
      : tool.status === "completed"
        ? "completed"
        : tool.status === undefined || tool.status === "pending"
          ? "pending"
          : "running";
  if (Option.isNone(input)) {
    // Droid's terminal Task update drops the input the launch reported; it still belongs
    // to that worker, so only a settled call may match one without its prompt.
    if (status !== "completed" && status !== "failed") return undefined;
    return {
      nativeTaskId: tool.toolCallId,
      childSessionId: null,
      prompt: "",
      title: null,
      model: null,
      status,
      result,
    };
  }
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: input.value.prompt,
    title: input.value.description ?? input.value.subagent_type ?? null,
    model: input.value.model ?? null,
    status,
    result,
  };
}

const isDroidForm = Schema.is(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.Array(Schema.String),
  }),
);
const isDroidQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: TrimmedNonEmptyString,
    oneOf: Schema.Array(
      Schema.Struct({
        const: Schema.String.check(Schema.isPattern(/^(?:option_\d+|other)$/)),
        title: TrimmedNonEmptyString,
      }),
    ),
  }),
);
const isDroidCompanion = Schema.is(Schema.Struct({ type: Schema.Literal("string") }));

// Droid pairs each choice with an optional *_other field. The client already
// offers custom answers, so hide the companion and restore it in the response.
export const extractDroidElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isDroidForm(request.requestedSchema)) return undefined;
  const { properties, required } = request.requestedSchema;
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [id, field] of Object.entries(properties)) {
    if (!/^question_[1-9]\d*$/.test(id)) continue;
    if (!isDroidQuestion(field) || !isDroidCompanion(properties[`${id}_other`])) return undefined;
    const options = field.oneOf
      .filter((option) => option.const !== "other")
      .map((option) => ({ label: option.title, description: option.title, value: option.const }));
    if (options.length === 0 || !field.oneOf.some((option) => option.const === "other")) {
      return undefined;
    }
    questions.push({ id, header: field.title, question: field.description, options });
  }
  // Recognize only complete forms; leave every other schema to the ACP fallback.
  const requiredIds = new Set(required);
  if (
    questions.length === 0 ||
    Object.keys(properties).length !== questions.length * 2 ||
    requiredIds.size !== questions.length ||
    questions.some((question) => !requiredIds.has(question.id))
  ) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const entries: Array<[string, string]> = [];
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (!Predicate.isString(answer) || answer.trim().length === 0) return { action: "cancel" };
        if (question.options.some((option) => option.value === answer)) {
          entries.push([question.id, answer]);
        } else {
          // Intake appends server attachment references to the selected choice ID.
          const attachmentStart = answer.indexOf("\n\n");
          const selectedOption = question.options.find(
            (option) =>
              option.value === answer.slice(0, attachmentStart) &&
              /^\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/.test(
                answer.slice(attachmentStart),
              ),
          );
          const text = selectedOption
            ? `${selectedOption.label}${answer.slice(attachmentStart)}`
            : answer;
          entries.push([question.id, "other"], [`${question.id}_other`, text]);
        }
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};
