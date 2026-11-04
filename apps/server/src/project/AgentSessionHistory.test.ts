import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as AgentSessionHistory from "./AgentSessionHistory.ts";

it.effect("generates a recap only on request and shares it until the source changes", () =>
  Effect.gen(function* () {
    let revision = "first";
    let preparing = true;
    let generations = 0;
    let changeDuringGeneration = false;
    const input = {
      workspaceRoot: "/workspace",
      session: {
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "session",
      },
    };
    yield* Effect.gen(function* () {
      const history = yield* AgentSessionHistory.AgentSessionHistory;
      expect((yield* history.generateRecap(input)).status).toBe("ready");
      expect(generations).toBe(0);
      preparing = false;
      expect((yield* history.previewSession(input)).status).toBe("ready");
      expect(generations).toBe(0);
      const results = yield* Effect.all(
        [history.generateRecap(input), history.generateRecap(input)],
        { concurrency: "unbounded" },
      );
      expect(generations).toBe(1);
      for (const result of results) {
        expect(result.status === "ready" ? result.recap : null).toEqual({
          summary: "The retry fix is ready; another-device verification remains.",
          nextAction: "Verify reconnecting from another device.",
        });
      }
      revision = "changed";
      const refreshed = yield* history.previewSession(input);
      expect(refreshed.status === "ready" ? refreshed.recap : null).toBeUndefined();
      yield* history.generateRecap(input);
      expect(generations).toBe(2);
      revision = "before-generation";
      changeDuringGeneration = true;
      expect(yield* history.generateRecap(input)).toEqual({
        status: "unavailable",
        reason: "changed",
      });
      const afterChange = yield* history.previewSession(input);
      expect(afterChange.status === "ready" ? afterChange.recap : null).toBeUndefined();
    }).pipe(
      Effect.provide(
        AgentSessionHistory.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettings.layerTest(),
              Layer.mock(AgentSessionScanner.AgentSessionScanner)({
                previewSession: () =>
                  Effect.sync(() => ({
                    status: "ready" as const,
                    revision,
                    title: "Fix reconnect",
                    model: null,
                    messages: preparing
                      ? []
                      : [
                          {
                            id: "message",
                            role: "assistant" as const,
                            text: "The retry fix is ready. Verify reconnecting from another device.",
                            truncated: false,
                            createdAt: "2026-11-01T00:00:00.000Z",
                          },
                        ],
                    nextCursor: null,
                  })),
              }),
              Layer.mock(TextGeneration.TextGeneration)({
                generateSessionRecap: (request) =>
                  Effect.sync(() => {
                    expect(request.recentMessages).toContain(
                      "Verify reconnecting from another device.",
                    );
                    generations += 1;
                    if (changeDuringGeneration) revision = "during-generation";
                    return {
                      summary: "The retry fix is ready; another-device verification remains.",
                      nextAction: "Verify reconnecting from another device.",
                    };
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);
