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

it.layer(NodeServices.layer)("Pi session attribution", (it) => {
  it.effect("uses the header workspace even when an earlier message names another workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const workspace = path.join(root, "workspace");
      const otherWorkspace = path.join(root, "other");
      const sessions = path.join(root, "pi", "sessions");
      const transcript = path.join(sessions, "session.jsonl");
      const now = Date.parse("2026-01-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      yield* fs.makeDirectory(workspace);
      yield* fs.makeDirectory(otherWorkspace);
      yield* fs.makeDirectory(sessions, { recursive: true });
      yield* fs.writeFileString(
        transcript,
        [
          {
            type: "message",
            id: "entry",
            parentId: null,
            cwd: otherWorkspace,
            message: { role: "user", content: "Review this project" },
          },
          { type: "session", id: "session", version: 3, cwd: workspace },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      );
      yield* fs.utimes(transcript, now / 1000, now / 1000);

      const scanner = yield* Effect.gen(function* () {
        const service = yield* AgentSessionScanner.AgentSessionScanner;
        const result = yield* service.scan;
        const threads = yield* Stream.runCollect(service.recentThreads(workspace));
        return { result, threads };
      }).pipe(
        Effect.provide(
          AgentSessionScanner.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerConfig.layerTest(root, { prefix: "t3code-pi-scan-" }),
                ServerSettings.layerTest({
                  providerInstances: {
                    [ProviderInstanceId.make("claudeAgent")]: {
                      driver: ProviderDriverKind.make("claudeAgent"),
                      config: { homePath: path.join(root, "claude") },
                    },
                    [ProviderInstanceId.make("codex")]: {
                      driver: ProviderDriverKind.make("codex"),
                      config: { homePath: path.join(root, "codex") },
                    },
                    [ProviderInstanceId.make("pi")]: {
                      driver: ProviderDriverKind.make("pi"),
                      enabled: true,
                      config: {},
                      environment: [
                        { name: "PI_CODING_AGENT_SESSION_DIR", value: sessions, sensitive: false },
                      ],
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

      expect(scanner.result.candidates.map((candidate) => candidate.path)).toEqual([workspace]);
      expect(Array.from(scanner.threads)).toMatchObject([
        { _tag: "Importable", thread: { providerSessionId: "session" } },
      ]);
    }),
  );
});
