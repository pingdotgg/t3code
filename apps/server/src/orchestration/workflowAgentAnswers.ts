// Path joining only; the filesystem access lives in readContainedWorkflowFile.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads what a workflow member actually answered.
 *
 * A member agent never becomes a provider task and emits nothing on the event
 * stream, so the transcript the harness writes is the only full record of its
 * turn — the progress snapshot carries a capped excerpt. The path is derived
 * here from the run's transcript directory and the member's provider id rather
 * than accepted from the caller, and the read itself is contained by
 * readContainedWorkflowFile.
 */
import * as NodePath from "node:path";

import { OrchestrationWorkflowFileError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { field, text } from "./unknownField.ts";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

const TRANSCRIPT_BYTE_CAP = 512 * 1024;

/** A member id names a file, so anything path-shaped is rejected outright. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Collects the assistant text of each turn in the harness's JSONL.
 *
 * Two shapes have to be handled: `attachment` lines and `isMeta` user lines are
 * harness bookkeeping (hook output, skill listings, injected context) and are
 * never conversation, and one assistant API message is split across several
 * lines sharing a `message.id`, so those are joined into a single turn rather
 * than read as separate ones.
 */
export function parseWorkflowAgentAnswers(contents: string): ReadonlyArray<string> {
  const turns: string[] = [];
  const turnIndexById = new Map<string, number>();

  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A capped read can cut the final line mid-object; drop it and keep the rest.
      continue;
    }
    if (text(field(entry, "type")) !== "assistant") continue;
    if (field(entry, "isMeta") === true) continue;

    const message = field(entry, "message");
    const content = field(message, "content");
    if (!Array.isArray(content)) continue;
    const body = content
      .filter((block) => text(field(block, "type")) === "text")
      .map((block) => field(block, "text"))
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n\n");
    if (body.length === 0) continue;

    const messageId = text(field(message, "id"));
    const existing = messageId === undefined ? undefined : turnIndexById.get(messageId);
    if (existing !== undefined) {
      turns[existing] = `${turns[existing]}\n\n${body}`;
      continue;
    }
    if (messageId !== undefined) turnIndexById.set(messageId, turns.length);
    turns.push(body);
  }

  return turns;
}

export const readWorkflowAgentAnswers = Effect.fn("orchestration.readWorkflowAgentAnswers")(
  function* (input: {
    readonly transcriptDir: string;
    readonly agentId: string;
    readonly configDir?: string;
  }) {
    if (!AGENT_ID_PATTERN.test(input.agentId)) {
      return yield* Effect.fail(
        new OrchestrationWorkflowFileError({ reason: "invalid-path", path: input.agentId }),
      );
    }
    const file = yield* readContainedWorkflowFile({
      path: NodePath.join(input.transcriptDir, `agent-${input.agentId}.jsonl`),
      extension: ".jsonl",
      byteCap: TRANSCRIPT_BYTE_CAP,
      tail: true,
      ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
    });
    return parseWorkflowAgentAnswers(
      file.truncated ? file.contents.slice(file.contents.indexOf("\n") + 1) : file.contents,
    );
  },
);
