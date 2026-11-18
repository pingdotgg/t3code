import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as VibeError from "@t3tools/vibe-app-server/errors";

import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type { VibeSettings } from "../settings.ts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { VibeAppServerClient } from "@t3tools/vibe-app-server/client";
import { resolveVibeModelId, withVibeAppServerClient } from "./appServerSupport.ts";

const VIBE_TEXT_GEN_TIMEOUT_MS = 180_000;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

const isTextGenerationError = Schema.is(TextGenerationError);

interface HistoryEntryLike {
  readonly role?: unknown;
  readonly type?: unknown;
  readonly content?: unknown;
}

function entryText(entry: HistoryEntryLike): string {
  if (entry.type !== "message" || !Array.isArray(entry.content)) return "";
  return entry.content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}

const waitForTurnTerminal = Effect.fn("VibeTextGeneration.waitForTurnTerminal")(function* (
  client: VibeAppServerClient["Service"],
  sessionId: string,
) {
  while (true) {
    const { state } = yield* client.sessionRead({ sessionId, history: null, turns: { limit: 1 } });
    const turn = state.turns?.at(-1);
    if (turn !== undefined && TERMINAL_TURN_STATUSES.has(turn.status)) return turn;
    yield* Effect.sleep("500 millis");
  }
});

export const makeVibeTextGeneration = Effect.fn("makeVibeTextGeneration")(function* (
  settings: VibeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runVibeJson: TextGenerationOperations.Runner = Effect.fn("VibeTextGeneration.runVibeJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const output = yield* withVibeAppServerClient(
        { settings, cwd, environment, clientInfo: { name: "t3-code-vibe-text", version: "0.0.0" } },
        (client) =>
          Effect.gen(function* () {
            const reasoningEffort = getModelSelectionStringOptionValue(modelSelection, "thinking");
            const started = yield* client.sessionStart({
              kind: "ephemeral",
              agentConfig: {
                cwd,
                headless: true,
                agent: "ask",
                autoApprove: false,
                disabledTools: ["*"],
                trustWorkspace: settings.trustWorkspace,
              },
              model: resolveVibeModelId(modelSelection.model),
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
              sessionOnly: true,
            });
            const sessionId = started.state.session.id;
            yield* Effect.addFinalizer(() =>
              client
                .sessionDelete(sessionId)
                .pipe(Effect.interruptible, Effect.timeoutOption("2 seconds"), Effect.ignore),
            );
            yield* client.sessionTurnEnqueue({
              sessionId,
              entries: [{ role: "user", content: [{ type: "text", text: prompt }] }],
            });
            const terminalTurn = yield* waitForTurnTerminal(client, sessionId);
            if (terminalTurn.status !== "completed") {
              return yield* new TextGenerationError({
                operation,
                detail: "Vibe did not complete the text generation turn.",
                cause: terminalTurn.error,
              });
            }
            const history = yield* client.sessionHistoryList({ sessionId, limit: 100 });
            // Only assistant messages are replies; the user's prompt must never be parsed as output.
            const reply = [...history.items]
              .reverse()
              .filter((item) => (item as HistoryEntryLike).role === "assistant")
              .map((item) => entryText(item as HistoryEntryLike))
              .find((text) => text.length > 0);
            return reply ?? "";
          }).pipe(Effect.scoped),
      ).pipe(
        // Scope the client so the app-server process is killed when the request ends.
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(VIBE_TEXT_GEN_TIMEOUT_MS),
        Effect.flatMap((option) =>
          option._tag === "None"
            ? Effect.fail(new TextGenerationError({ operation, detail: "Vibe request timed out." }))
            : Effect.succeed(option.value),
        ),
        Effect.mapError((cause: VibeError.VibeAppServerError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Vibe app server request failed.",
                cause,
              }),
        ),
      );

      if (!output) {
        return yield* new TextGenerationError({
          operation,
          detail: "Vibe returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Vibe", output);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Vibe text generation failed.",
                cause,
              }),
        ),
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "VibeTextGeneration",
    TextGenerationOperations.withoutInvestigation("Vibe", runVibeJson),
  );
});
