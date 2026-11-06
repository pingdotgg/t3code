import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitHubCopilotSettings } from "../settings.ts";
import type { CopilotSdkClient } from "./copilotSdkRuntime.ts";
import { makeGitHubCopilotTextGeneration } from "./textGeneration.ts";

const settings = Schema.decodeSync(GitHubCopilotSettings)({ binaryPath: process.execPath });

it.layer(NodeServices.layer)("GitHub Copilot text generation", (it) => {
  it.effect("reads the model's JSON reply and sends the selected model", () =>
    Effect.gen(function* () {
      let model: string | undefined;
      const generation = makeGitHubCopilotTextGeneration({
        settings,
        environment: {},
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        makeClient: () =>
          ({
            generateText: async (input: { readonly model: string }) => {
              model = input.model;
              return 'Here you go: {"title":"Fix the login flow"}';
            },
          }) as unknown as CopilotSdkClient,
      });

      const result = yield* generation.generateThreadTitle({
        cwd: "/repo",
        message: "the login is broken",
        modelSelection: {
          instanceId: ProviderInstanceId.make("githubCopilot"),
          model: "claude-haiku-4.5",
        },
      });

      assert.strictEqual(result.title, "Fix the login flow");
      assert.strictEqual(model, "claude-haiku-4.5");
    }),
  );
});
