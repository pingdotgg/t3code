import { assert, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";

import { GitHubCli } from "./GitHubCli.ts";
import { GitLabCli } from "./GitLabCli.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import type { VcsDriverShape } from "../vcs/VcsDriver.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
}) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriverShape>;

  const registryLayer = Layer.mock(VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriverShape),
    resolve: () =>
      Effect.succeed({
        kind: "git",
        repository: {
          kind: "git",
          rootPath: "/repo",
          metadataPath: null,
          freshness: {
            source: "live-local" as const,
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        },
        driver: driver as unknown as VcsDriverShape,
      }),
  });

  return SourceControlProviderRegistry.make().pipe(
    Effect.provide(
      Layer.mergeAll(registryLayer, Layer.mock(GitHubCli)({}), Layer.mock(GitLabCli)({})),
    ),
  );
}

it.effect("routes GitHub remotes to the GitHub provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:pingdotgg/t3code.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("routes directly by provider kind for remote-first workflows", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [],
    });

    const provider = yield* registry.get("github");

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("routes GitLab remotes to the GitLab provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@gitlab.com:group/project.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("falls back to a non-origin remote when origin is not configured", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "upstream", url: "https://dev.azure.com/acme/project/_git/repo" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);
