import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as VibeError from "@t3tools/vibe-app-server/errors";

import { TextGenerationError } from "@t3tools/contracts";
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
    const turns = yield* client.sessionTurnsList({ sessionId, limit: 20 });
    const active = turns.find((turn) => !TERMINAL_TURN_STATUSES.has(turn.status));
    if (active === undefined) return;
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
            const started = yield* client.sessionStart({
              kind: "ephemeral",
              agentConfig: {
                cwd,
                headless: true,
                trustWorkspace: settings.trustWorkspace,
              },
              ...(resolveVibeModelId(modelSelection.model) !== ""
                ? { model: resolveVibeModelId(modelSelection.model) }
                : {}),
              sessionOnly: true,
            });
            const sessionId = started.state.session.id;
            yield* client.sessionTurnEnqueue({
              sessionId,
              entries: [{ role: "user", content: [{ type: "text", text: prompt }] }],
            });
            yield* waitForTurnTerminal(client, sessionId);
            const history = yield* client.sessionHistoryList({ sessionId, limit: 100 });
            const reply = [...history.items]
              .reverse()
              .map((item) => entryText(item as HistoryEntryLike))
              .find((text) => text.length > 0);
            yield* client.sessionDelete(sessionId).pipe(Effect.ignore);
            return reply ?? "";
          }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(VIBE_TEXT_GEN_TIMEOUT_MS),
        Effect.flatMap((option) =>
          option._tag === "None"
            ? Effect.fail(
                new TextGenerationError({ operation, detail: "Mistral Vibe request timed out." }),
              )
            : Effect.succeed(option.value),
        ),
        Effect.mapError((cause: VibeError.VibeAppServerError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Mistral Vibe app server request failed.",
                cause,
              }),
        ),
      );

      if (!output) {
        return yield* new TextGenerationError({
          operation,
          detail: "Mistral Vibe returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Mistral Vibe", output);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Mistral Vibe text generation failed.",
                cause,
              }),
        ),
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "VibeTextGeneration",
    TextGenerationOperations.withoutInvestigation("Mistral Vibe", runVibeJson),
  );
});
