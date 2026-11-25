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

it.layer(NodeServices.layer)("Claude shell history", (it) => {
  it.effect.each([
    {
      name: "a leading shell command followed by a prompt",
      messages: ["<bash-input>git status</bash-input>", "Fix the login bug"],
      title: "Fix the login bug",
      omittedMessageCount: 0,
    },
    {
      name: "a prompt outside the retained history after an opening shell command",
      messages: [
        "<bash-input>pwd</bash-input>",
        "Fix the login bug",
        ...Array.from({ length: 200 }, () => "<command-name>/clear</command-name>"),
      ],
      title: "Fix the login bug",
      omittedMessageCount: 2,
    },
    {
      name: "a shell command outside the retained history",
      messages: [
        "<command-name>/clear</command-name>",
        "<bash-input>pwd</bash-input>",
        ...Array.from({ length: 200 }, () => "<command-name>/clear</command-name>"),
      ],
      title: "!pwd",
      omittedMessageCount: 2,
    },
  ])("imports sessions with $name", ({ messages, title, omittedMessageCount }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-shell-" });
      const workspace = path.join(root, "workspace");
      const claudeHome = path.join(root, "claude");
      const transcripts = path.join(claudeHome, "projects", "-slug");
      yield* fs.makeDirectory(workspace);
      yield* fs.makeDirectory(transcripts, { recursive: true });
      const file = path.join(transcripts, "shell-session.jsonl");
      yield* fs.writeFileString(
        file,
        messages
          .map((content) =>
            JSON.stringify({
              type: "user",
              cwd: workspace,
              sessionId: "shell-session",
              message: { role: "user", content },
            }),
          )
          .join("\n"),
      );
      const now = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(now);
      const modifiedAtSeconds = now / 1000 - 60;
      yield* fs.utimes(file, modifiedAtSeconds, modifiedAtSeconds);

      const [result] = yield* AgentSessionScanner.AgentSessionScanner.use((scanner) =>
        scanner.recentThreads(workspace).pipe(Stream.runCollect),
      ).pipe(
        Effect.provide(
          AgentSessionScanner.layer.pipe(
            Layer.provide([
              ServerConfig.layerTest(root, { prefix: "t3code-claude-shell-config-" }),
              ServerSettings.layerTest({
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: claudeHome },
                  },
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: false,
                  },
                  [ProviderInstanceId.make("pi")]: {
                    driver: ProviderDriverKind.make("pi"),
                    enabled: false,
                  },
                },
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
              Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
                list: () => Effect.succeed([]),
              }),
            ]),
          ),
        ),
      );

      expect(result).toMatchObject({ _tag: "Importable", thread: { title, omittedMessageCount } });
    }),
  );
});
