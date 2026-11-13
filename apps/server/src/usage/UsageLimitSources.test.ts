import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { SecretProviderId, ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

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
    ]),
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
    ]),
  );
});

it.effect("reads routed sessions from opted-in hubs, even with no client open", () =>
  Effect.gen(function* () {
    const queueReads: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.headers.authorization).toBe("Bearer key");
        const url = new URL(request.url);
        if (url.pathname.endsWith("/usage-queue")) {
          queueReads.push(url.host);
          return HttpClientResponse.fromWeb(
            request,
            Response.json([{ session_id: "thread-session", auth_index: "a" }]),
          );
        }
        if (url.pathname.endsWith("/auth-files")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              files: [{ id: "claude-a.json", auth_index: "a", provider: "claude" }],
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ status_code: 200, body: JSON.stringify({}) }),
        );
      }),
    );
    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    yield* sources.refresh;
    yield* TestClock.adjust("30 seconds");

    const snapshots = yield* sources.current;
    expect(queueReads).toEqual(["routed.test"]);
    expect(
      snapshots.map((source) => [source.id, source.accounts.map((account) => account.sessionIds)]),
    ).toEqual([
      ["routed", [["thread-session"]]],
      ["observed", [undefined]],
    ]);

    // Switching Thread accounts off drops the routes on that refresh, not on the next queue read.
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      usageLimitSources: {
        [UsageLimitSourceId.make("routed")]: {
          kind: "cliproxy",
          url: "https://routed.test",
          managementKey: "key",
          enabled: true,
          threadAccounts: false,
        },
      },
    });
    yield* sources.refresh;
    const afterOff = yield* sources.current;
    expect(afterOff.find((source) => source.id === "routed")?.accounts[0]?.sessionIds).toBe(
      undefined,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        read: (references) => Effect.succeed(references.map(() => "key")),
        invalidate: () => Effect.void,
        label: (provider) => Effect.succeed(provider),
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("routed")]: {
            kind: "cliproxy",
            url: "https://routed.test",
            managementKey: {
              provider: SecretProviderId.make("homelab"),
              reference: "cliproxy#key",
            },
            enabled: true,
            threadAccounts: true,
          },
          [UsageLimitSourceId.make("observed")]: {
            kind: "cliproxy",
            url: "https://observed.test",
            managementKey: "key",
            enabled: true,
          },
        },
      }),
      // No client lease: a turn that ends while nobody watches must still keep its route.
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("drops a queue read that lands after Thread accounts was switched off", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/usage-queue")) {
        return Deferred.await(release).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              Response.json([{ session_id: "thread-session", auth_index: "a" }]),
            ),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          url.pathname.endsWith("/auth-files")
            ? Response.json({
                files: [{ id: "claude-a.json", auth_index: "a", provider: "claude" }],
              })
            : Response.json({ status_code: 200, body: JSON.stringify({}) }),
        ),
      );
    });
    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    yield* sources.refresh;
    // The 30-second queue read starts and waits on the hub.
    yield* TestClock.adjust("30 seconds");

    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      usageLimitSources: {
        [UsageLimitSourceId.make("routed")]: {
          kind: "cliproxy",
          url: "https://routed.test",
          managementKey: "key",
          enabled: true,
          threadAccounts: false,
        },
      },
    });
    yield* sources.refresh;
    yield* Deferred.succeed(release, undefined);
    yield* TestClock.adjust("1 second");

    const snapshots = yield* sources.current;
    expect(snapshots[0]?.accounts[0]?.sessionIds).toBe(undefined);
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
        label: (provider) => Effect.succeed(provider),
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("routed")]: {
            kind: "cliproxy",
            url: "https://routed.test",
            managementKey: "key",
            enabled: true,
            threadAccounts: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
