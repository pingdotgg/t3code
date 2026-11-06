import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  SecretProviderId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

vi.mock("./commandCodeLimits.ts", () => ({
  readCommandCodeLimitSource: () =>
    Effect.succeed({
      id: UsageLimitSourceId.make("command-code-local"),
      kind: "cliproxy" as const,
      label: "Command Code",
      checkedAt: "2026-11-02T00:00:00.000Z",
      accounts: [
        {
          id: "Command Code",
          driver: ProviderDriverKind.make("command-code"),
          usageLimits: { checkedAt: "2026-11-02T00:00:00.000Z", windows: [] },
        },
      ],
    }),
}));

it("recognizes Command Code by provider driver or ACP agent, never by instance key", () => {
  const providerInstances = {
    [ProviderInstanceId.make("cc")]: {
      driver: ProviderDriverKind.make("acpRegistry"),
      config: { agentId: "command-code-omarchy" },
    },
  };
  expect(UsageLimitSources.hasConfiguredCommandCodeProvider(providerInstances)).toBe(true);
  expect(
    UsageLimitSources.hasConfiguredCommandCodeProvider({
      [ProviderInstanceId.make("command-code-pretender")]: {
        driver: ProviderDriverKind.make("opencode"),
      },
    }),
  ).toBe(false);
  expect(
    UsageLimitSources.hasConfiguredCommandCodeProvider({
      [ProviderInstanceId.make("direct")]: { driver: ProviderDriverKind.make("command-code") },
    }),
  ).toBe(true);
  expect(
    UsageLimitSources.hasConfiguredCommandCodeProvider({
      [ProviderInstanceId.make("unrelated")]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        config: { agentId: "other-agent" },
      },
    }),
  ).toBe(false);
});

it.effect("refreshes usage limits when a Command Code provider instance is added", () =>
  Effect.gen(function* () {
    const baseContext = yield* Layer.build(ServerSettings.layerTest());
    const baseSettings = Context.get(baseContext, ServerSettings.ServerSettingsService);
    const initial = yield* baseSettings.getSettings;
    const current = yield* Ref.make(initial);
    const updates = yield* Queue.unbounded<typeof initial>();
    const initialEventProcessed = yield* Deferred.make<void>();
    const settings = {
      ...baseSettings,
      getSettings: Ref.get(current),
      streamChanges: Stream.concat(
        Stream.make(initial),
        Stream.unwrap(
          Deferred.succeed(initialEventProcessed, undefined).pipe(
            Effect.as(Stream.fromQueue(updates)),
          ),
        ),
      ),
    };

    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
    );
    yield* sources.refresh;
    yield* Deferred.await(initialEventProcessed);
    expect(yield* sources.current).toEqual([]);
    const published = yield* sources.streamChanges.pipe(
      Stream.filter((snapshots) =>
        snapshots.some((snapshot) => snapshot.id === "command-code-local"),
      ),
      Stream.runHead,
      Effect.forkScoped,
    );

    const configured = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        [ProviderInstanceId.make("cc")]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { agentId: "command-code" },
        },
      },
    };
    yield* Ref.set(current, configured);
    yield* Queue.offer(updates, configured);
    const update = yield* Fiber.join(published);
    expect(update._tag).toBe("Some");
    expect(update._tag === "Some" ? update.value[0]?.accounts[0]?.driver : null).toBe(
      "command-code",
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
        label: (provider) => Effect.succeed(provider),
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
      NodeServices.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
      NodeServices.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
      NodeServices.layer,
    ]),
    Effect.scoped,
  );
});
