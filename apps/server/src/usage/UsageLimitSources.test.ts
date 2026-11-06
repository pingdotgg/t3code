import { UsageProviderFilter } from "@t3tools/provider-core/server/usageLimits";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import {
  EnvironmentId,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeSourceBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSourceRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ auth_index: Schema.String, url: Schema.String })),
);

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("seeds hub sources at startup and keeps malformed URLs encodable for subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
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
    ]),
    Effect.scoped,
  );
});

it.effect.each(["listing", "quota", "changed-account"] as const)(
  "retains provider-filtered readings through %s failures with account isolation",
  (failure) => {
    let requests = 0;
    let fail = false;
    let includeCodex = false;
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      yield* sources.streamChanges.pipe(
        Stream.filter((next) => next.length > 0),
        Stream.runHead,
      );
      includeCodex = true;
      yield* sources.refresh.pipe(Effect.provideService(UsageProviderFilter, ["claudeAgent"]));
      expect((yield* sources.current)[0]?.accounts.map((account) => account.driver)).toEqual([
        "claudeAgent",
      ]);
      yield* sources.refresh.pipe(Effect.provideService(UsageProviderFilter, ["codex"]));
      expect((yield* sources.current)[0]?.accounts.map((account) => account.driver).sort()).toEqual(
        ["claudeAgent", "codex"],
      );
      const prior = (yield* sources.current)[0]!;
      const beforeHiddenRefresh = requests;
      yield* sources.refresh.pipe(Effect.provideService(UsageProviderFilter, ["cursor"]));
      expect(requests).toBe(beforeHiddenRefresh);
      expect((yield* sources.current)[0]).toEqual(prior);
      yield* TestClock.adjust("5 minutes");
      fail = true;
      yield* sources.refresh;
      const failed = (yield* sources.current)[0]!;
      if (failure === "changed-account") {
        expect(
          failed.accounts.every(
            (account) =>
              account.usageLimits.windows.length === 0 &&
              account.usageLimits.unavailable?.reason === "probeFailed",
          ),
        ).toBe(true);
      } else if (failure === "listing")
        expect(failed.accounts).toEqual(
          prior.accounts.map((account) => ({
            ...account,
            usageLimits: { ...account.usageLimits, stale: true, refreshAfter: 600_000 },
          })),
        );
      if (failure === "quota")
        expect(failed.accounts.map((account) => account.usageLimits)).toEqual(
          prior.accounts.map((account) => ({
            ...account.usageLimits,
            refreshAfter: 600_000,
            stale: true,
          })),
        );
      if (failure === "listing") expect(failed.error).toContain("401");
      else expect(failed.error).toBeUndefined();
      fail = false;
      yield* sources.refresh.pipe(Effect.provideService(UsageProviderFilter, ["codex"]));
      expect(
        (yield* sources.current)[0]?.accounts.find((account) => account.driver === "claudeAgent")
          ?.usageLimits.stale,
      ).toBe(failure === "changed-account" ? undefined : true);
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
          label: (provider) => Effect.succeed(provider),
          read: () => Effect.succeed([]),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests++;
              if (fail && failure === "listing")
                return HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }));
              if (request.url.endsWith("/auth-files"))
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    files: [
                      { id: "claude", auth_index: "claude", provider: "claude" },
                      ...(includeCodex
                        ? [{ id: "codex", auth_index: "codex", provider: "codex" }]
                        : []),
                    ].map((account) => ({
                      ...account,
                      auth_index:
                        fail && failure === "changed-account"
                          ? `${account.auth_index}-new`
                          : account.auth_index,
                    })),
                  }),
                );
              const input = decodeSourceRequest(
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "{}",
              );
              if (fail)
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status_code: 503, body: "{}" }),
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
  },
);

it.effect.each([
  { code: "reset", failure: "listing" },
  { code: "already_redeemed", failure: "listing" },
  { code: "no_credit", failure: "listing" },
  { code: "reset", failure: "quota" },
  { code: "already_redeemed", failure: "quota" },
  { code: "no_credit", failure: "quota" },
] as const)(
  "removes retained credits after $code during $failure failures",
  ({ code, failure }) => {
    let consumed = false;
    const sourceId = UsageLimitSourceId.make("hub");
    const otherId = UsageLimitSourceId.make("other-hub");
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((next) => next.length === 2),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(
        collectLimitAccounts(
          new Map(
            initial.map(
              (source, index) =>
                [
                  EnvironmentId.make(`env-${index}`),
                  {
                    entry: { target: { label: `Environment ${index}` } },
                    serverConfig: { providers: [], usageLimitSources: [source] },
                  },
                ] as const,
            ),
          ),
        ),
      ).toHaveLength(4);
      const before = initial.find((source) => source.id === sourceId)!;
      expect(before.accounts[0]?.usageLimits.resetCredits?.nextCreditId).toBe("credit");
      const outcome =
        code === "reset" ? "reset" : code === "already_redeemed" ? "alreadyRedeemed" : "noCredit";
      expect(
        yield* sources.consumeResetCredit({ sourceId, accountId: "first", creditId: "credit" }),
      ).toEqual({ outcome });
      if (failure === "quota") {
        yield* TestClock.adjust("5 minutes");
        yield* sources.refresh;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const snapshots = yield* sources.current;
        const after = snapshots.find((source) => source.id === sourceId)!;
        if (failure === "listing") expect(after.error).toContain("503");
        else expect(after.error).toBeUndefined();
        expect(after.accounts[0]?.usageLimits.stale).toBe(true);
        expect(after.accounts[0]?.usageLimits.windows).toEqual(
          before.accounts[0]?.usageLimits.windows,
        );
        expect(after.accounts[0]?.usageLimits.resetCredits?.nextCreditId).toBeUndefined();
        expect(after.accounts[0]?.usageLimits.resetCredits?.availableCount ?? 0).toBe(0);
        expect(after.accounts[1]?.usageLimits.resetCredits).toEqual(
          before.accounts[1]?.usageLimits.resetCredits,
        );
        expect(
          snapshots
            .find((source) => source.id === otherId)
            ?.accounts.map((account) => [
              account.usageLimits.windows,
              account.usageLimits.resetCredits,
            ]),
        ).toEqual(
          initial
            .find((source) => source.id === otherId)
            ?.accounts.map((account) => [
              account.usageLimits.windows,
              account.usageLimits.resetCredits,
            ]),
        );
        if (attempt === 0) yield* sources.refresh;
      }
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest({
          usageLimitSources: {
            [sourceId]: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: "key",
              enabled: true,
            },
            [otherId]: {
              kind: "cliproxy",
              url: "https://other.test",
              managementKey: "key",
              enabled: true,
            },
          },
        }),
        Layer.succeed(SecretResolver.SecretResolver, {
          label: (provider) => Effect.succeed(provider),
          read: () => Effect.succeed([]),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              if (request.url.endsWith("/auth-files"))
                return HttpClientResponse.fromWeb(
                  request,
                  consumed && failure === "listing" && new URL(request.url).host === "hub.test"
                    ? Response.json({}, { status: 503 })
                    : Response.json({
                        files: [
                          { id: "first", auth_index: "a", provider: "codex" },
                          { id: "second", auth_index: "b", provider: "codex" },
                        ],
                      }),
                );
              if (request.url.endsWith("/reset-quota"))
                return HttpClientResponse.fromWeb(request, Response.json({}));
              const input = decodeSourceRequest(
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "{}",
              );
              if (input.url.endsWith("/consume")) consumed = true;
              if (
                consumed &&
                failure === "quota" &&
                new URL(request.url).host === "hub.test" &&
                input.url.endsWith("/usage")
              )
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status_code: 503, body: "{}" }),
                );
              const body = input.url.endsWith("/consume")
                ? { code }
                : input.url.endsWith("/rate-limit-reset-credits")
                  ? {
                      credits:
                        consumed &&
                        input.auth_index === "a" &&
                        new URL(request.url).host === "hub.test"
                          ? []
                          : [
                              {
                                id: "credit",
                                expires_at: "2099-01-01T00:00:00Z",
                                status: "available",
                                reset_type: "codex_rate_limits",
                              },
                            ],
                    }
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
  },
);
