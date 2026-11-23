import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { patchNumberFromId } from "../shared/definition.ts";
import * as RadicleSourceControlProvider from "./RadicleSourceControlProvider.ts";
import { PATCH, RID, radicleLayer, type Run } from "./radicleTestFixtures.ts";

const NID = "z6MkPeer33333333333333333333333333333333333333";

const withFiles = (layer: ReturnType<typeof radicleLayer>) =>
  Layer.merge(layer, FileSystem.layerNoop({ readFileString: () => Effect.succeed("The body\n") }));

it.effect("keys the identity by repository ID, whichever peer remote sorted first", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadicleSourceControlProvider.make;
    const identity = yield* provider.refineRepositoryIdentity!({
      identity: {
        canonicalKey: `rad://${RID.toLowerCase()}/${NID.toLowerCase()}`,
        locator: {
          source: "git-remote",
          remoteName: `peer@${NID}`,
          remoteUrl: `rad://${RID}/${NID}`,
        },
        rootPath: "/repo",
        provider: SourceControlProviderKind.make("radicle"),
        owner: RID.toLowerCase(),
        name: NID.toLowerCase(),
      },
      resolveContext: () => Effect.succeed(null),
    });
    assert.deepStrictEqual(identity, {
      canonicalKey: `radicle/${RID.toLowerCase()}`,
      locator: { source: "git-remote", remoteName: "rad", remoteUrl: `rad://${RID}` },
      webUrl: `https://radicle.network/nodes/seed.radicle.dev/rad:${RID}`,
      rootPath: "/repo",
      provider: SourceControlProviderKind.make("radicle"),
      name: RID,
      displayName: `rad:${RID}`,
    });
  }).pipe(
    Effect.provide(
      withFiles(
        radicleLayer({
          runs,
          git: { readConfigValue: () => Effect.succeed(`rad://${RID}`) },
        }),
      ),
    ),
  );
});

it.effect("opens a patch from the branch and records the patch as its upstream", () => {
  const runs: Array<Run> = [];
  const config: Array<[string, string]> = [];
  return Effect.gen(function* () {
    const provider = yield* RadicleSourceControlProvider.make;
    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "feature",
      title: "Add usage",
      bodyFile: "/tmp/body.md",
      draft: true,
    });
    const push = runs.find((run) => run.command === "git" && run.args[0] === "push");
    assert.deepStrictEqual(push?.args, [
      "push",
      "-o",
      "patch.message=Add usage",
      "-o",
      "patch.message=The body",
      "-o",
      "patch.draft",
      "rad",
      "refs/heads/feature:refs/patches",
    ]);
    assert.deepStrictEqual(config, [
      ["branch.feature.remote", "rad"],
      ["branch.feature.merge", `refs/heads/patches/${PATCH}`],
    ]);
  }).pipe(
    Effect.provide(
      withFiles(
        radicleLayer({
          runs,
          answer: (input) =>
            input.command === "git" && input.args[0] === "push"
              ? `✓ Patch ${PATCH} opened\n`
              : undefined,
          git: {
            writeConfigValue: (input) =>
              Effect.sync(() => {
                config.push([input.key, input.value]);
              }),
          },
        }),
      ),
    ),
  );
});

it.effect("finds the patch a branch tracks through its upstream", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadicleSourceControlProvider.make;
    const [changeRequest] = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature",
      state: "open",
    });
    assert.strictEqual(changeRequest?.number, patchNumberFromId(PATCH));
    assert.strictEqual(changeRequest?.headRefName, "feature");
    assert.strictEqual(changeRequest?.baseRefName, "main");
  }).pipe(
    Effect.provide(
      withFiles(
        radicleLayer({
          runs,
          answer: (input) =>
            input.command === "git" && input.args[0] === "config"
              ? `refs/heads/patches/${PATCH}\n`
              : undefined,
        }),
      ),
    ),
  );
});

it.effect("names a patch by number, hex prefix, or explorer link", () =>
  Effect.sync(() => {
    const number = patchNumberFromId(PATCH);
    assert.strictEqual(RadicleSourceControlProvider.patchNumberFromReference(`${number}`), number);
    assert.strictEqual(
      RadicleSourceControlProvider.patchNumberFromReference(PATCH.slice(0, 12)),
      number,
    );
    assert.strictEqual(
      RadicleSourceControlProvider.patchNumberFromReference(
        `https://radicle.network/nodes/seed.radicle.dev/rad:${RID}/patches/${PATCH}`,
      ),
      number,
    );
    assert.strictEqual(RadicleSourceControlProvider.patchNumberFromReference("57045d7"), null);
  }),
);
