import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  CapturedStepOutputReader,
  type CapturedStepOutputReaderShape,
} from "../Services/CapturedStepOutputReader.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";

const decodeCapturedJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const findLastJsonBlock = (text: string) => {
  const jsonBlock = /```json\s*([\s\S]*?)```/gi;
  let last: string | undefined;
  let match: RegExpExecArray | null = null;
  while ((match = jsonBlock.exec(text)) !== null) {
    last = match[1]?.trim();
  }
  return last;
};

const parseCapturedOutput = (text: string): Effect.Effect<unknown> => {
  const block = findLastJsonBlock(text);
  if (block === undefined) {
    return Effect.void;
  }
  return decodeCapturedJson(block).pipe(
    Effect.map((value) =>
      typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );
};

const toReaderError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const make = Effect.gen(function* () {
  const projectionTurns = yield* ProjectionTurnRepository;
  const threadMessages = yield* ProjectionThreadMessageRepository;

  const read: CapturedStepOutputReaderShape["read"] = (input) =>
    Effect.gen(function* () {
      const turn = yield* projectionTurns
        .getByTurnId({
          threadId: input.threadId,
          turnId: input.turnId,
        })
        .pipe(Effect.mapError(toReaderError("structured output turn lookup failed")));
      if (Option.isNone(turn) || turn.value.assistantMessageId === null) {
        return undefined;
      }

      const message = yield* threadMessages
        .getByMessageId({ messageId: turn.value.assistantMessageId })
        .pipe(Effect.mapError(toReaderError("structured output message lookup failed")));
      if (Option.isNone(message)) {
        return undefined;
      }

      const fromFinalMessage = yield* parseCapturedOutput(message.value.text);
      if (fromFinalMessage !== undefined) {
        return fromFinalMessage;
      }

      // Agents with multi-message turns (progress notes, skill-driven
      // formats) sometimes emit the fenced block before their closing
      // remark — scan the turn's earlier assistant messages, newest first.
      const allMessages = yield* threadMessages
        .listByThreadId({ threadId: input.threadId })
        .pipe(Effect.mapError(toReaderError("structured output turn messages lookup failed")));
      const turnAssistantMessages = allMessages.filter(
        (candidate) =>
          candidate.turnId === (input.turnId as string) &&
          candidate.role === "assistant" &&
          candidate.messageId !== turn.value.assistantMessageId,
      );
      for (const candidate of [...turnAssistantMessages].toReversed()) {
        const parsed = yield* parseCapturedOutput(candidate.text);
        if (parsed !== undefined) {
          return parsed;
        }
      }
      return undefined;
    });

  return { read } satisfies CapturedStepOutputReaderShape;
});

export const CapturedStepOutputReaderLive = Layer.effect(CapturedStepOutputReader, make);
