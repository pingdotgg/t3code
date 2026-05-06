import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { runProcess } from "../processRunner.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import {
  SourceControlRepositoryService,
  SourceControlRepositoryServiceLive,
} from "./SourceControlRepositoryService.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "forma-source-control-test-",
});

const SourceControlRepositoryServiceTestLayer = SourceControlRepositoryServiceLive.pipe(
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry)({
      get: () => Effect.die("provider lookup is not used for raw Git URL clones"),
      discover: Effect.succeed([]),
    }),
  ),
  Layer.provide(GitCoreLive),
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

async function createSourceRepository(root: string): Promise<string> {
  const sourcePath = path.join(root, "source");
  await mkdir(sourcePath, { recursive: true });
  await runProcess("git", ["init"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "README.md"), "# cloned\n");
  await runProcess("git", ["add", "README.md"], { cwd: sourcePath });
  await runProcess(
    "git",
    [
      "-c",
      "user.name=Forma Test",
      "-c",
      "user.email=forma-test@example.com",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: sourcePath },
  );
  return sourcePath;
}

it.effect("clones a raw Git URL into the destination before returning success", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService;
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "forma-source-control-")));

    try {
      const sourcePath = yield* Effect.promise(() => createSourceRepository(root));
      const destinationPath = path.join(root, "destination");
      yield* Effect.promise(() => mkdir(destinationPath, { recursive: true }));

      const result = yield* service.cloneRepository({
        remoteUrl: sourcePath,
        destinationPath,
        protocol: "auto",
      });

      assert.equal(result.cwd, destinationPath);
      assert.equal(result.remoteUrl, sourcePath);
      assert.equal(
        yield* Effect.promise(() => readFile(path.join(destinationPath, "README.md"), "utf8")),
        "# cloned\n",
      );
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(SourceControlRepositoryServiceTestLayer)),
);
