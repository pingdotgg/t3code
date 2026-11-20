import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

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
const extractDroidElicitationForm: NonNullable<AcpAdapterV2Flavor["extractElicitationForm"]> = (
  request,
) => {
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

const DROID_LEVELS_HIGHEST_FIRST = ["auto-high", "auto-medium", "auto-low", "normal"];

// Droid's session modes are its autonomy levels, and a new session can start at
// `auto-high`, which runs every action without asking. `normal` asks before each
// change, so T3's runtime policy answers; only unrestricted full access skips asking.
// An organization can cap the levels, and Droid then advertises only the ones it accepts.
function droidSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  advertisedModeIds: ReadonlyArray<string>,
): string | undefined {
  const unrestricted =
    policy.runtimeMode === "full-access" &&
    policy.approvalPolicy === undefined &&
    policy.sandboxPolicy === undefined;
  return (unrestricted ? DROID_LEVELS_HIGHEST_FIRST : ["normal"]).find((level) =>
    advertisedModeIds.includes(level),
  );
}

export const droidAcpFlavor = {
  extractElicitationForm: extractDroidElicitationForm,
  // The policy picks the level, so T3 never sends the composer's Autonomy Level choice.
  ownedModelOptionIds: ["autonomy_level"],
  lockSessionModeToPolicy: true,
  sessionModeForPolicy: droidSessionModeForPolicy,
} satisfies Partial<AcpAdapterV2Flavor>;
