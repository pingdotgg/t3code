import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  DEFAULT_SERVER_SETTINGS,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import type {
  SourceControlCliDiscoverySpec,
  SourceControlManagedCliDiscoverySpec,
  SourceControlProviderDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { fakeSourceControlProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const kind = SourceControlProviderKind.make;

class NotAnswered extends Schema.TaggedError<NotAnswered>()("NotAnswered", {}) {}

const linkSubject = (host: string) => () =>
  Effect.succeed({ title: `${host} subject`, body: null });

/** Only GitHub and GitLab read linked subjects, as in production. */
const PROVIDERS = [
  fakeSourceControlProvider("github", { resolveLink: linkSubject("github") }),
  fakeSourceControlProvider("gitlab", { resolveLink: linkSubject("gitlab") }),
  fakeSourceControlProvider("forgejo"),
  fakeSourceControlProvider("bitbucket"),
  fakeSourceControlProvider("azure-devops"),
];

/** A host CLI that claims every server it is signed in to, as `glab` does. */
const claimingCli = (claims: string): SourceControlCliDiscoverySpec => ({
  type: "cli",
  kind: kind(claims),
  label: claims,
  installHint: `Install ${claims}.`,
  executable: `${claims}-cli`,
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  remoteRefinementArgs: ({ provider }) => ["auth", "status", "--hostname", provider.name],
  parseAuth: () => ({
    status: "unknown",
    account: Option.none(),
    host: Option.none(),
    detail: Option.none(),
  }),
  refineUnknownRemote: ({ context, auth }) =>
    auth.stdout.includes(`Logged in to ${context.provider.name}`)
      ? { kind: kind(claims), name: `${claims} Self-Hosted`, baseUrl: context.provider.baseUrl }
      : null,
});

const managedCli = (
  claims: string,
  refine: SourceControlManagedCliDiscoverySpec["refineUnknownRemote"],
): SourceControlManagedCliDiscoverySpec => ({
  type: "managed-cli",
  kind: kind(claims),
  label: claims,
  installHint: `Install ${claims}.`,
  probe: () => Effect.die("unused"),
  refineUnknownRemote: refine,
});

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
  readonly discovery?: ReadonlyArray<SourceControlProviderDiscoverySpec>;
  readonly run?: SourceControlHost.SourceControlHost["Service"]["process"]["run"];
  readonly settings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
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
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const discovery = input.discovery ?? [claimingCli("gitlab")];
  return SourceControlProviderRegistry.makeWithProviders(
    PROVIDERS.map((provider) => ({
      kind: provider.kind,
      provider,
      discovery: discovery.find((spec) => spec.kind === provider.kind) ?? {
        type: "api",
        kind: provider.kind,
        label: provider.kind,
        installHint: "unused",
        probeAuth: Effect.succeed({
          status: "unknown",
          account: Option.none(),
          host: Option.none(),
          detail: Option.none(),
        }),
      },
    })),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
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
              driver: driver as unknown as VcsDriver.VcsDriver["Service"],
            }),
        }),
        TestSourceControlHost.layer({
          process: {
            run: input.run ?? (() => Effect.succeed(TestSourceControlHost.processOutput(""))),
          },
        }),
        input.settings
          ? Layer.mock(ServerSettings.ServerSettingsService)(input.settings)
          : ServerSettings.ServerSettingsService.layerTest(),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

const signedIn = (host: string) => () =>
  Effect.succeed(TestSourceControlHost.processOutput(`  ✓ Logged in to ${host} as user\n`));

it.effect("routes an unknown remote to the integration that claims its server", () =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@self-hosted.example.test:group/project.git" }],
      run: (input) => {
        asked.push([input.command, ...input.args].join(" "));
        return signedIn("self-hosted.example.test")();
      },
    });

    const handle = yield* registry.resolveHandle({ cwd: "/repo" });

    assert.strictEqual(handle.provider.kind, "gitlab");
    assert.deepStrictEqual(handle.context?.provider, {
      kind: kind("gitlab"),
      name: "gitlab Self-Hosted",
      baseUrl: "https://self-hosted.example.test",
    });
    assert.deepStrictEqual(asked, ["gitlab-cli auth status --hostname self-hosted.example.test"]);
  }),
);

it.effect("leaves a remote no integration claims unknown, with its server's address", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@code.example.test:team/project.git" }],
    });
    const handle = yield* registry.resolveHandle({ cwd: "/repo" });
    assert.strictEqual(handle.provider.kind, kind("unknown"));
    assert.strictEqual(handle.context?.provider.baseUrl, "https://code.example.test");
  }),
);

it.effect("refines the caller-selected remote instead of choosing another configured remote", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:fork/project.git" }],
      run: signedIn("self-hosted.example.test"),
    });

    const handle = yield* registry.resolveHandle({
      cwd: "/repo",
      context: {
        provider: {
          kind: kind("unknown"),
          name: "self-hosted.example.test",
          baseUrl: "https://self-hosted.example.test",
        },
        remoteName: "upstream",
        remoteUrl: "https://self-hosted.example.test/group/project.git",
      },
    });

    assert.strictEqual(handle.context?.provider.kind, "gitlab");
    assert.strictEqual(handle.context?.remoteName, "upstream");
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

it.effect(
  "routes linked subjects to the host that serves them, independently of the checkout",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        remotes: [{ name: "origin", url: "https://github.com/unrelated/checkout.git" }],
      });
      for (const [url, host] of [
        ["https://github.com/team/project/issues/1", "github"],
        ["https://gitlab.com/team/sub/project/-/merge_requests/2", "gitlab"],
      ] as const) {
        const lookup = registry.resolveLink({ cwd: "/unrelated", url: new URL(url) });
        assert.ok(lookup);
        assert.deepStrictEqual(yield* lookup, { title: `${host} subject`, body: null });
      }
      for (const url of [
        "https://example.test/team/project/issues/1",
        "https://codeberg.org/team/project/issues/1",
        "https://bitbucket.org/team/project/pull-requests/1",
        "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
        "http://github.com/team/project/issues/1",
        "https://user:secret@github.com/team/project/issues/1",
      ]) {
        assert.strictEqual(
          registry.resolveLink({ cwd: "/unrelated", url: new URL(url) }),
          undefined,
          url,
        );
      }
    }).pipe(Effect.scoped),
);

it.effect("does not refine a context whose server address is empty", () =>
  Effect.gen(function* () {
    let asked = 0;
    const remoteUrl = "git@githubenterprise.dev.example.com:team/workspace.git";
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: remoteUrl }],
      discovery: [
        managedCli("github", ({ context }) => {
          asked += 1;
          return Effect.succeed(
            context.provider.baseUrl === ""
              ? null
              : { kind: kind("github"), name: "GitHub", baseUrl: context.provider.baseUrl },
          );
        }),
      ],
    });
    const context = {
      provider: { kind: kind("unknown"), name: "Unknown", baseUrl: "" },
      remoteName: "origin",
      remoteUrl,
    };
    assert.deepStrictEqual(
      (yield* registry.resolveHandle({ cwd: "/repo", context })).context,
      context,
    );

    const resolved = yield* registry.resolveHandle({ cwd: "/repo" });
    assert.strictEqual(resolved.provider.kind, "github");
    assert.strictEqual(
      resolved.context?.provider.baseUrl,
      "https://githubenterprise.dev.example.com",
    );
    assert.strictEqual(asked, 2);
  }),
);

const notFound = (command: string, cwd: string) =>
  new VcsProcessSpawnError({
    operation: "test",
    command,
    cwd,
    cause: PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
  });

const resolveUnknown = (
  registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
  repository: string,
) =>
  registry.resolveHandle({
    cwd: `/${repository}`,
    context: {
      provider: {
        kind: kind("unknown"),
        name: "git.example.internal",
        baseUrl: "https://git.example.internal",
      },
      remoteName: "origin",
      remoteUrl: `git@Git.Example.Internal:team/${repository}.git`,
    },
  });

it.effect("asks once for every checkout of a server no integration claims", () =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const release = yield* Deferred.make<void>();
    const registry = yield* makeRegistry({
      remotes: [],
      discovery: [
        claimingCli("gitlab"),
        managedCli("github", ({ context }) => {
          asked.push(`managed ${context.provider.name}`);
          return Effect.succeed(null);
        }),
      ],
      run: ({ command, args, cwd }) => {
        asked.push([command, ...args].join(" "));
        return Deferred.await(release).pipe(Effect.andThen(Effect.fail(notFound(command, cwd))));
      },
    });

    const started = yield* Effect.forEach(["a", "b", "c"], () => Deferred.make<void>());
    const callers = yield* Effect.forEach(
      ["a", "b", "c"],
      (repository, index) =>
        Deferred.succeed(started[index]!, undefined).pipe(
          Effect.andThen(resolveUnknown(registry, repository)),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Effect.forEach(started, Deferred.await);
    yield* Deferred.succeed(release, undefined);
    const handles = yield* Fiber.join(callers);
    yield* resolveUnknown(registry, "d");
    assert.deepStrictEqual(
      handles.map((handle) => handle.provider.kind),
      ["unknown", "unknown", "unknown"],
    );
    const once = asked.slice();
    assert.sameMembers(once, [
      "managed git.example.internal",
      "gitlab-cli auth status --hostname git.example.internal",
    ]);

    yield* TestClock.adjust("5 minutes");
    yield* resolveUnknown(registry, "a");
    assert.deepStrictEqual(asked, [...once, ...once]);
  }),
);

it.effect("asks again after a check that could not answer", () =>
  Effect.gen(function* () {
    let asks = 0;
    let managedAsks = 0;
    const registry = yield* makeRegistry({
      remotes: [],
      discovery: [
        claimingCli("gitlab"),
        managedCli("github", () => {
          managedAsks += 1;
          return Effect.fail(new NotAnswered());
        }),
      ],
      run: ({ command, cwd }) => {
        asks += 1;
        return Effect.fail(
          new VcsProcessTimeoutError({ operation: "test", command, cwd, timeoutMs: 1 }),
        );
      },
    });
    yield* resolveUnknown(registry, "a");
    yield* resolveUnknown(registry, "b");
    assert.strictEqual(asks, 2);
    assert.strictEqual(managedAsks, 2);
  }),
);

it.effect("asks again once Settings change", () =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
    const handled = yield* Deferred.make<void>();
    let claims = false;
    const registry = yield* makeRegistry({
      remotes: [],
      settings: {
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(
              Stream.flatMap((settings) =>
                Stream.concat(
                  Stream.make(settings),
                  Stream.fromEffectDrain(Deferred.succeed(handled, undefined)),
                ),
              ),
            ),
          ),
        ),
      },
      discovery: [
        managedCli("github", ({ context }) =>
          Effect.succeed(
            claims
              ? { kind: kind("github"), name: "GitHub", baseUrl: context.provider.baseUrl }
              : null,
          ),
        ),
      ],
    });
    assert.strictEqual((yield* resolveUnknown(registry, "a")).provider.kind, "unknown");
    claims = true;
    assert.strictEqual((yield* resolveUnknown(registry, "b")).provider.kind, "unknown");

    yield* PubSub.publish(changes, DEFAULT_SERVER_SETTINGS);
    yield* Deferred.await(handled);
    assert.strictEqual((yield* resolveUnknown(registry, "c")).provider.kind, "github");
  }),
);

it.effect("answers discovery without waiting on a hosting API that stalls", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [],
      discovery: [
        claimingCli("gitlab"),
        {
          type: "api",
          kind: kind("bitbucket"),
          label: "Bitbucket",
          installHint: "unused",
          probeAuth: Effect.never,
        },
      ],
    });
    const discovering = yield* registry.discover.pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    const items = yield* Fiber.join(discovering);
    const bitbucket = items.find((item) => item.kind === "bitbucket");
    assert.strictEqual(bitbucket?.status, "available");
    assert.strictEqual(bitbucket?.auth.status, "unknown");
    assert.strictEqual(items.find((item) => item.kind === "gitlab")?.status, "available");
  }),
);
