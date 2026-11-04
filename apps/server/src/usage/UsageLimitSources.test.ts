import { UsageProviderFilter } from "@t3tools/provider-core/server/usageLimits";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { SecretProviderId, ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeSourceBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSourceRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ auth_index: Schema.String, url: Schema.String })),
);

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
    yield* sources.refresh;
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
    Effect.scoped,
  );
});

it.effect("retains another window's account when provider-filtered usage refreshes finish", () => {
  let fail = false;
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh.pipe(Effect.provideService(UsageProviderFilter, ["claudeAgent"]));
    expect((yield* sources.current)[0]?.accounts.map((account) => account.driver)).toEqual([
      "claudeAgent",
    ]);
    yield* sources.refresh.pipe(Effect.provideService(UsageProviderFilter, ["codex"]));
    expect((yield* sources.current)[0]?.accounts.map((account) => account.driver).sort()).toEqual([
      "claudeAgent",
      "codex",
    ]);
    const prior = (yield* sources.current)[0]!;
    fail = true;
    yield* sources.refresh;
    const failed = (yield* sources.current)[0]!;
    expect(failed.accounts).toEqual(
      prior.accounts.map((account) => ({
        ...account,
        usageLimits: { ...account.usageLimits, stale: true },
      })),
    );
    expect(failed.error).toContain("401");
    fail = false;
    yield* sources.refresh.pipe(Effect.provideService(UsageProviderFilter, ["codex"]));
    expect(
      (yield* sources.current)[0]?.accounts.find((account) => account.driver === "claudeAgent")
        ?.usageLimits.stale,
    ).toBe(true);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "https://hub.test",
            managementKey: "key",
            enabled: true,
          },
        },
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        read: () => Effect.succeed([]),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (fail)
              return HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }));
            if (request.url.endsWith("/auth-files"))
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  files: [
                    { id: "claude", auth_index: "claude", provider: "claude" },
                    { id: "codex", auth_index: "codex", provider: "codex" },
                  ],
                }),
              );
            const input = decodeSourceRequest(
              request.body._tag === "Uint8Array"
                ? new TextDecoder().decode(request.body.body)
                : "{}",
            );
            const body = input.url.endsWith("/rate-limit-reset-credits")
              ? { credits: [] }
              : input.auth_index === "claude"
                ? { five_hour: { utilization: 20, resets_at: null } }
                : { rate_limit: { primary_window: { used_percent: 20 } } };
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ status_code: 200, body: encodeSourceBody(body) }),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  );
});
