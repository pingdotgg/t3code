import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Cline advertises `provider` and then `model`, both `category: "model"`. The
 * model picker selects the provider; the later `model` option is an ordinary
 * option descriptor, picked here as discovery publishes it after the provider
 * switch.
 */
export const CLINE_SECONDARY_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("acpRegistry"),
  model: "cline-pass",
  options: [{ id: "model", value: "cline-pass/muse-spark-1.3-contributor" }] as const,
} satisfies ModelSelection;

const OptionalText = Schema.optionalKey(Schema.String);
// The config options of a `session/new` or `session/set_config_option` answer.
const decodeClineAnswer = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      configOptions: Schema.Array(
        Schema.Union([
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            description: OptionalText,
            category: OptionalText,
            type: Schema.Literal("select"),
            currentValue: Schema.String,
            options: Schema.Array(
              Schema.Struct({
                value: Schema.String,
                name: Schema.String,
                description: OptionalText,
              }),
            ),
          }),
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            description: OptionalText,
            category: OptionalText,
            type: Schema.Literal("boolean"),
            currentValue: Schema.Boolean,
          }),
        ]),
      ),
    }),
  }),
);

/**
 * The config options in the replay's answer labelled `label`. The transcript is
 * shaped after Cline 3.0.70's `acpAgent.ts` source, not captured from a Cline run.
 */
export function clineConfigOptionsAnsweredAt(transcript: ProviderReplayTranscript, label: string) {
  const entry = transcript.entries.find(
    (candidate) => candidate.type === "emit_inbound" && candidate.label === label,
  );
  return decodeClineAnswer(entry?.type === "emit_inbound" ? entry.frame : undefined).result
    .configOptions;
}
