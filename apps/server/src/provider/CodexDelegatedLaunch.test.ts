import * as CodexSchema from "effect-codex-app-server/schema";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { selectLaunchCandidate } from "../orchestration-v2/DelegatedLaunchAdmission.ts";
import { assert, it } from "@effect/vitest";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import { readCodexLaunchCapacity, verifyCodexLaunchBinding } from "./CodexDelegatedLaunch.ts";

const decodeRateLimits = Schema.decodeUnknownEffect(CodexSchema.V2GetAccountRateLimitsResponse);

function runtime(
  options: {
    snapshot?: CodexSchema.V2GetAccountRateLimitsResponse;
    provider?: string;
    providers?: unknown;
    chatgptBaseUrl?: string;
    accountId?: string | null;
    accountSwap?: boolean;
    used?: number;
    ordinaryUsageAllowed?: boolean | null | undefined;
  } = {},
) {
  let accounts = 0;
  const calls: string[] = [];
  const client = {
    request: (method: string) =>
      Effect.sync(() => {
        calls.push(method);
        if (method === "config/read")
          return {
            config: {
              model_provider: options.provider ?? "openai",
              model_providers: options.providers,
              chatgpt_base_url: options.chatgptBaseUrl,
            },
          };
        if (method === "account/read")
          return {
            account: {
              type: "chatgpt",
              email:
                options.accountSwap && accounts++ > 0
                  ? "changed@example.com"
                  : "direct@example.com",
              planType: "pro",
            },
          };
        if (method === "account/rateLimits/read")
          return (
            options.snapshot ?? {
              accountId:
                options.accountId === undefined ? "opaque-backend-account" : options.accountId,
              ordinaryUsageAllowed:
                "ordinaryUsageAllowed" in options ? options.ordinaryUsageAllowed : true,
              rateLimits: {
                primary: { usedPercent: options.used ?? 1 },
                secondary: { usedPercent: 2 },
              },
            }
          );
        if (method === "thread/read")
          return { thread: { modelProvider: options.provider ?? "openai" } };
        throw new Error(`Unexpected control ${method}`);
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  return { client, calls };
}

const domains = ["codex:account:direct@example.com", "codex:credential:opaque-backend-account"];

it.effect("admits healthy direct Codex and validates that identity on the dispatch session", () =>
  Effect.gen(function* () {
    const probe = runtime();
    const capacity = yield* readCodexLaunchCapacity(probe.client, {});
    assert.equal(capacity.usageLimits.credentialFingerprint, "opaque-backend-account");
    const dispatch = runtime();
    yield* verifyCodexLaunchBinding(dispatch.client, {}, domains, "native-thread");
    assert.deepEqual(dispatch.calls, [
      "config/read",
      "account/read",
      "account/rateLimits/read",
      "account/read",
      "thread/read",
    ]);
  }),
);

it.effect(
  "denies pools, false config claims, stale bindings and changed accounts before dispatch",
  () =>
    Effect.gen(function* () {
      for (const options of [
        { provider: "pool" },
        { chatgptBaseUrl: "https://pool.invalid" },
        { providers: { openai: { base_url: "https://pool.invalid" } } },
        { accountId: null },
        { accountId: "changed-account" },
        { accountSwap: true },
        { used: 100 },
        { used: -1 },
        { used: 101 },
        { used: NaN },
        { ordinaryUsageAllowed: false },
      ]) {
        const dispatch = runtime(options);
        const error = yield* verifyCodexLaunchBinding(
          dispatch.client,
          {},
          domains,
          "native-thread",
        ).pipe(Effect.flip);
        assert.equal(error._tag, "CodexLaunchCapacityError");
        assert.isFalse(dispatch.calls.includes("turn/start"));
      }
      const direct = runtime();
      yield* verifyCodexLaunchBinding(
        direct.client,
        { OPENAI_BASE_URL: "https://pool.invalid" },
        domains,
        "native-thread",
      ).pipe(Effect.flip);
      yield* verifyCodexLaunchBinding(direct.client, {}, ["pinned"], "native-thread").pipe(
        Effect.flip,
      );
    }),
);

it.effect(
  "retains verified exhausted capacity without inventing usage and rejects it at dispatch",
  () =>
    Effect.gen(function* () {
      for (const options of [{ used: 100 }, { used: 12, ordinaryUsageAllowed: false }]) {
        const probe = runtime(options);
        const capacity = yield* readCodexLaunchCapacity(probe.client, {});
        assert.equal(capacity.email, "direct@example.com");
        assert.equal(capacity.usageLimits.credentialFingerprint, "opaque-backend-account");
        assert.equal(capacity.usageLimits.windows[0]?.usedPercent, options.used);
        assert.equal(
          capacity.usageLimits.ordinaryUsageAllowed,
          options.ordinaryUsageAllowed ?? true,
        );
        const dispatch = runtime(options);
        const error = yield* verifyCodexLaunchBinding(
          dispatch.client,
          {},
          domains,
          "native-thread",
        ).pipe(Effect.flip);
        assert.equal("code" in error ? error.code : undefined, "usage_limit");
        assert.isFalse(dispatch.calls.includes("thread/read"));
      }
    }),
);

it.effect(
  "rejects native account snapshots whose permission was withheld after an identity mismatch",
  () =>
    Effect.gen(function* () {
      for (const ordinaryUsageAllowed of [null, undefined]) {
        const probe = runtime({ ordinaryUsageAllowed });
        yield* readCodexLaunchCapacity(probe.client, {}).pipe(Effect.flip);
        assert.isFalse(probe.calls.includes("turn/start"));
      }
    }),
);

it.effect("uses canonical backend account identity and admits a weekly-only native snapshot", () =>
  Effect.gen(function* () {
    // Synthetic capture of the native 0.163 account/rateLimits/read schema.
    // account_processor.rs maps response.account_id to accountId and withholds
    // ordinaryUsageAllowed unless it matches active auth account AND user.
    const accountId = "00000000-0000-4000-8000-000000000001";
    const snapshot = yield* decodeRateLimits({
      accountId,
      ordinaryUsageAllowed: true,
      rateLimits: {
        primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1793000000 },
        secondary: null,
        credits: null,
        planType: "pro",
      },
    });
    for (const rateLimits of [
      { ...snapshot.rateLimits, primary: null, secondary: null },
      { ...snapshot.rateLimits, primary: { ...snapshot.rateLimits.primary!, usedPercent: -1 } },
    ]) {
      yield* readCodexLaunchCapacity(
        runtime({ snapshot: { ...snapshot, rateLimits } }).client,
        {},
      ).pipe(Effect.flip);
    }
    const capacity = yield* readCodexLaunchCapacity(runtime({ snapshot }).client, {});
    assert.equal(capacity.usageLimits.windows.length, 1);
    assert.equal(capacity.usageLimits.windows[0]?.kind, "weekly");
    assert.equal(capacity.usageLimits.credentialFingerprint, accountId);
    const same = { instanceId: ProviderInstanceId.make("direct"), model: "gpt-6.1-sol" };
    const independent = { instanceId: ProviderInstanceId.make("spare"), model: "gpt-6.1-sol" };
    const at = DateTime.formatIso(yield* DateTime.now);
    const probe = (target: typeof same) =>
      Effect.succeed({
        probeStartedAt: Date.parse(at),
        provider: {
          instanceId: target.instanceId,
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: at,
          models: [{ slug: target.model, name: target.model, isCustom: false, capabilities: null }],
          slashCommands: [],
          skills: [],
          version: null,
          usageLimits: {
            ...capacity.usageLimits,
            checkedAt: at,
            credentialFingerprint:
              target.instanceId === same.instanceId
                ? accountId
                : "00000000-0000-4000-8000-000000000002",
          },
        } satisfies ServerProvider,
      });
    const healthy = yield* selectLaunchCandidate({ candidates: [same], probe });
    assert.equal(healthy.status, "ready");
    // Proxy metadata.account_id uses this same backend/workspace identity.
    const selected = yield* selectLaunchCandidate({
      candidates: [same, independent],
      blockedDomains: [`codex:credential:${accountId}`],
      probe,
    });
    assert.equal(selected.status, "ready");
    if (selected.status === "ready")
      assert.equal(selected.selection.instanceId, independent.instanceId);
  }),
);
