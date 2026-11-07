import * as Schema from "effect/Schema";

import type { FrontDecision } from "./FrontModel.ts";

/**
 * Both engines constrain output to this schema. Every key is required because llama.cpp grammars
 * cannot express optional properties; an empty task decodes as no task.
 */
export const FRONT_DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { enum: ["reply", "delegate", "note", "none"] },
    speech: { type: "string" },
    task: { type: "string" },
  },
  required: ["action", "speech", "task"],
  additionalProperties: false,
} as const;

const Decision = Schema.Struct({
  action: Schema.Literals(["reply", "delegate", "note", "none"]),
  speech: Schema.String,
  task: Schema.optional(Schema.String),
});
const decodeDecision = Schema.decodeUnknownOption(Schema.fromJsonString(Decision));

/** Undefined when the text is not a decision. "none" never speaks, whatever the model wrote. */
export function parseFrontDecision(text: string): FrontDecision | undefined {
  const decoded = decodeDecision(text.trim());
  if (decoded._tag === "None") return undefined;
  const { action, task } = decoded.value;
  const speech = action === "none" ? "" : decoded.value.speech.trim();
  const trimmedTask = task?.trim();
  return trimmedTask ? { action, speech, task: trimmedTask } : { action, speech };
}
