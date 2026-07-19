import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import { VcsChangeService, layer } from "./VcsChangeService.ts";

const RegistryLayer = Layer.effect(
  VcsDriverRegistry.VcsDriverRegistry,
  Effect.gen(function* () {
    const driver = yield* VcsDriver.VcsDriver;
    return VcsDriverRegistry.VcsDriverRegistry.of({
      get: () => Effect.succeed(driver),
      detect: (input) =>
        driver
          .detectRepository(input.cwd)
          .pipe(
            Effect.map((repository) =>
              repository ? { kind: "jj" as const, repository, driver } : null,
            ),
          ),
      resolve: (input) =>
        driver
          .detectRepository(input.cwd)
          .pipe(
            Effect.flatMap((repository) =>
              repository
                ? Effect.succeed({ kind: "jj" as const, repository, driver })
                : Effect.die(`Expected a Jujutsu repository at ${input.cwd}`),
            ),
          ),
    });
  }),
).pipe(Layer.provide(JjVcsDriver.layer));

const TestLayer = Layer.merge(layer.pipe(Layer.provide(RegistryLayer)), JjVcsDriver.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("VcsChangeService", (it) => {
  it.effect("prepares AI context and finalizes selected and remaining jj changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const changes = yield* VcsChangeService;
      const repository = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-phase5-" });
      yield* driver.initRepository({ cwd: repository, kind: "jj" });

      const selectedPath = "selected snow-雪.txt";
      const excludedPath = "excluded.txt";
      yield* fileSystem.writeFileString(path.join(repository, selectedPath), "selected\n");
      yield* fileSystem.writeFileString(path.join(repository, excludedPath), "excluded\n");

      const context = yield* changes.prepareMessageContext({
        cwd: repository,
        filePaths: [selectedPath],
      });
      assert.isNotNull(context);
      assert.include(context?.summary ?? "", selectedPath);
      assert.notInclude(context?.summary ?? "", excludedPath);
      assert.include(context?.patch ?? "", selectedPath);
      assert.notInclude(context?.patch ?? "", excludedPath);

      const selected = yield* changes.finalizeChange({
        cwd: repository,
        message: "Finalize selected file",
        filePaths: [selectedPath],
        createPublishRef: "feature/selected-change",
      });
      assert.equal(selected.status, "created");
      if (selected.status !== "created") return;
      assert.notEqual(selected.finalizedRevision.changeId, selected.workspaceRevision.changeId);
      assert.deepStrictEqual(selected.publishRef, {
        kind: "bookmark",
        name: "feature/selected-change",
        target: selected.finalizedRevision,
      });

      const finalizedPatch = yield* driver.execute({
        operation: "VcsChangeService.test.finalizedPatch",
        cwd: repository,
        args: ["diff", "--git", "--revision", "@-"],
      });
      assert.include(finalizedPatch.stdout, selectedPath);
      assert.notInclude(finalizedPatch.stdout, excludedPath);

      const remainingPatch = yield* driver.execute({
        operation: "VcsChangeService.test.remainingPatch",
        cwd: repository,
        args: ["diff", "--git", "--revision", "@"],
      });
      assert.include(remainingPatch.stdout, excludedPath);
      assert.notInclude(remainingPatch.stdout, selectedPath);

      const remaining = yield* changes.finalizeChange({
        cwd: repository,
        message: "Finalize remaining file",
      });
      assert.equal(remaining.status, "created");

      const empty = yield* changes.finalizeChange({ cwd: repository, message: "Nothing left" });
      assert.deepStrictEqual(empty, { status: "skipped_no_changes" });
    }),
  );

  it.effect("rejects empty messages and invalid selected paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const changes = yield* VcsChangeService;
      const repository = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-phase5-" });
      yield* driver.initRepository({ cwd: repository, kind: "jj" });

      yield* Effect.flip(changes.finalizeChange({ cwd: repository, message: "   " }));
      yield* fileSystem.writeFileString(`${repository}/changed.txt`, "changed\n");
      const error = yield* Effect.flip(
        changes.finalizeChange({
          cwd: repository,
          message: "Invalid selection",
          filePaths: ["../outside.txt"],
        }),
      );
      assert.include(error.detail, "not changed");
    }),
  );
});
