import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverManifests } from "./manifests.ts";

describe("discoverManifests", () => {
  it.effect("finds manifests in a root's repositories, with the repository each belongs to", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-manifests-test-" });
      const write = (relative: string, content = "") =>
        Effect.gen(function* () {
          const file = path.join(home, relative);
          yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
          yield* fileSystem.writeFileString(file, content);
        });
      yield* write("code/app/agents/agent.yaml", "metadata:\n  name: app\n");
      yield* write("code/app/agents/agent.nested.yaml", "metadata:\n  name: app-nested\n");
      yield* write("code/app/agents/agent.yaml.bak");
      yield* write("code/app/node_modules/pkg/agent.yaml");
      yield* write("code/app/.git/agent.yaml");
      yield* write("code/loose/agents/agent.yaml", "metadata:\n  name: loose\n");
      yield* write("code/a/b/c/d/e/agent.yaml");

      const manifests = yield* discoverManifests([path.join(home, "code")]);
      assert.deepStrictEqual(
        manifests.map(({ path: manifestPath, repository, variant, agentName }) => ({
          path: path.relative(home, manifestPath),
          repository: path.relative(home, repository),
          variant,
          agentName,
        })),
        [
          {
            path: "code/app/agents/agent.yaml",
            repository: "code/app",
            variant: null,
            agentName: "app",
          },
          {
            path: "code/app/agents/agent.nested.yaml",
            repository: "code/app",
            variant: "nested",
            agentName: "app-nested",
          },
          {
            path: "code/loose/agents/agent.yaml",
            repository: "code",
            variant: null,
            agentName: "loose",
          },
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
