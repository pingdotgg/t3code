import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

it.layer(NodeServices.layer)("Claude session metadata budget", (it) => {
  it.effect.each([
    {
      name: "eight large transcripts that fit the budget",
      sizes: [9, 7, 7, 7, 7, 7, 7, 7],
      skipped: 0,
    },
    { name: "a newer transcript too large to finish", sizes: [63, 2], skipped: 1 },
    { name: "a transcript that only fits when each byte is read once", sizes: [63.5], skipped: 0 },
  ])("imports Claude sessions with $name", ({ sizes, skipped }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-metadata-" });
      const claudeHome = path.join(root, "claude");
      const project = path.join(claudeHome, "projects", "-test");
      const workspace = path.join(root, "workspace");
      yield* fs.makeDirectory(project, { recursive: true });
      yield* fs.makeDirectory(workspace);

      const now = Date.parse("2026-08-24T12:00:00Z");
      yield* TestClock.setTime(now);
      const sessions = sizes.map((size, index) => ({ sessionId: `image-${index}`, size }));
      for (const [index, { sessionId, size }] of [
        ...sessions,
        { sessionId: "older", size: 0 },
      ].entries()) {
        const message = {
          role: "user",
          content: [
            { type: "text", text: "Review this" },
            ...(size === 0
              ? []
              : [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "A".repeat(size * 1024 * 1024),
                    },
                  },
                ]),
          ],
        };
        const transcript = path.join(project, `${sessionId}.jsonl`);
        yield* fs.writeFileString(
          transcript,
          JSON.stringify({ type: "user", sessionId, message, cwd: workspace }) + "\n",
        );
        const seconds = now / 1000 - 60 - index;
        yield* fs.utimes(transcript, seconds, seconds);
      }

      const outcomes = yield* Effect.gen(function* () {
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        return yield* Stream.runCollect(scanner.recentThreads(workspace));
      }).pipe(
        Effect.provide(
          AgentSessionScanner.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerConfig.layerTest(root, { prefix: "t3code-claude-metadata-config-" }),
                ServerSettings.layerTest({
                  providerInstances: {
                    [ProviderInstanceId.make("claudeAgent")]: {
                      driver: ProviderDriverKind.make("claudeAgent"),
                      config: { homePath: claudeHome },
                    },
                    [ProviderInstanceId.make("codex")]: {
                      driver: ProviderDriverKind.make("codex"),
                      enabled: false,
                      config: {},
                    },
                    [ProviderInstanceId.make("pi")]: {
                      driver: ProviderDriverKind.make("pi"),
                      enabled: false,
                      config: {},
                    },
                  },
                }),
                Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
                Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
                  list: () => Effect.succeed([]),
                }),
              ),
            ),
          ),
        ),
      );
      const imported = Array.from(outcomes).flatMap((outcome) =>
        outcome._tag === "Importable" ? [outcome.thread.providerSessionId] : [],
      );
      expect(imported).toEqual([
        ...sessions.slice(skipped).map(({ sessionId }) => sessionId),
        "older",
      ]);
    }),
  );
});
