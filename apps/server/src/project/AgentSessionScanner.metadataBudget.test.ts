import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
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
  it.effect("finds older sessions before retrying transcripts with large screenshots", () =>
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
      const image = {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "A".repeat(3 * 1024 * 1024),
        },
      };
      for (const sessionId of ["older", ...Array.from({ length: 8 }, (_, i) => `image-${i}`)]) {
        const older = sessionId === "older";
        const message = {
          role: "user",
          content: [{ type: "text", text: "Review this" }, ...(older ? [] : [image, image, image])],
        };
        const transcript = path.join(project, `${sessionId}.jsonl`);
        yield* fs.writeFileString(
          transcript,
          JSON.stringify({ type: "user", sessionId, message, cwd: workspace }) + "\n",
        );
        const seconds = now / 1000 - (older ? 120 : 60);
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
                    claudeAgent: {
                      driver: ProviderDriverKind.make("claudeAgent"),
                      config: { homePath: claudeHome },
                    },
                    codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
                    pi: { driver: ProviderDriverKind.make("pi"), enabled: false, config: {} },
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
      expect(imported).toContain("older");
      expect(imported).toContain("image-0");
    }),
  );
});
