import type { DelegatedLaunchBinding, ServerProviderUsageLimits } from "@t3tools/contracts";
import type { DelegatedLaunchPool } from "@t3tools/provider-core/server/driver";
import type * as CodexClient from "effect-codex-app-server/client";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { codexRateLimitsToLimits } from "./codexUsageLimits.ts";

export class CodexLaunchCapacityError extends Schema.TaggedError<CodexLaunchCapacityError>()(
  "CodexLaunchCapacityError",
  { code: Schema.Literals(["usage_limit", "delegated_capacity_unverified"]) },
) {}

// Configured instance labels cannot establish which account a wrapper dispatches.
// Read the resolved runtime's controls and require the backend's account binding.
export const readCodexLaunchCapacity = Effect.fn("readCodexLaunchCapacity")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  environment: NodeJS.ProcessEnv,
) {
  const { config } = yield* client.request("config/read", { includeLayers: false });
  const providers = config.model_providers;
  if (
    (config.model_provider != null && config.model_provider !== "openai") ||
    (typeof providers === "object" && providers !== null && "openai" in providers) ||
    config.chatgpt_base_url != null ||
    environment.OPENAI_BASE_URL?.trim() ||
    environment.OPENAI_API_KEY?.trim() ||
    environment.CODEX_API_KEY?.trim()
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const account = (yield* client.request("account/read", {})).account;
  const limits = yield* client.request("account/rateLimits/read", null);
  const confirmed = (yield* client.request("account/read", {})).account;
  if (
    account?.type !== "chatgpt" ||
    confirmed?.type !== "chatgpt" ||
    !account.email?.trim() ||
    account.email !== confirmed.email ||
    !limits.accountId?.trim() ||
    typeof limits.ordinaryUsageAllowed !== "boolean"
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const raw = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits;
  const includedWindows = [raw.primary, raw.secondary].filter((window) => window != null);
  if (
    includedWindows.length === 0 ||
    includedWindows.some(
      (w) => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100,
    )
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const usageLimits: ServerProviderUsageLimits = {
    ...codexRateLimitsToLimits({
      snapshot: limits.rateLimits,
      rateLimitsByLimitId: limits.rateLimitsByLimitId,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    }),
    credentialFingerprint: limits.accountId,
    // The app-server may send null for "not reported"; only a boolean is evidence.
    ...(typeof limits.ordinaryUsageAllowed === "boolean"
      ? { ordinaryUsageAllowed: limits.ordinaryUsageAllowed }
      : {}),
  };
  if (!usageLimits.windows.some((w) => w.id === "primary" || w.id === "secondary"))
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  // Exhaustion is verified evidence; admission needs its identity to block aliases.
  return { email: account.email.trim().toLowerCase(), usageLimits };
});

export const verifyCodexLaunchBinding = Effect.fn("verifyCodexLaunchBinding")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  environment: NodeJS.ProcessEnv,
  domains: ReadonlyArray<string>,
  nativeThreadId: string,
) {
  const capacity = yield* readCodexLaunchCapacity(client, environment);
  if (
    capacity.usageLimits.ordinaryUsageAllowed === false ||
    capacity.usageLimits.windows.some((w) => w.usedPercent >= 100)
  )
    return yield* new CodexLaunchCapacityError({ code: "usage_limit" });
  const { thread } = yield* client.request("thread/read", {
    threadId: nativeThreadId,
    includeTurns: false,
  });
  if (
    thread.modelProvider !== "openai" ||
    !domains.includes(`codex:account:${capacity.email}`) ||
    !domains.includes(`codex:credential:${capacity.usageLimits.credentialFingerprint}`)
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
});

// The wrapper names its bound provider table; anything else is an unbound process.
const CODEX_POOL_NATIVE_PROVIDER = "cliproxy_bound";

/**
 * Before the first turn of a pool-bound launch: this process must have been
 * spawned for exactly this lease, and the lease must still be unused. The
 * proxy re-probes quota and pins the account at dispatch; this check only
 * prevents generation on a stale, reused or already refused lease.
 */
export const verifyCodexPoolLaunch = Effect.fn("verifyCodexPoolLaunch")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly pool?: DelegatedLaunchPool;
  readonly sessionBinding?: DelegatedLaunchBinding;
  readonly binding: DelegatedLaunchBinding;
  readonly nativeThreadId: string;
}) {
  if (
    !input.pool ||
    input.sessionBinding?.result.bindingId !== input.binding.result.bindingId ||
    input.sessionBinding.prepareRequest.clientRequestId !==
      input.binding.prepareRequest.clientRequestId
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const state = yield* input.pool.state(input.binding);
  if (state?.refusal?.code === "usage_limit")
    return yield* new CodexLaunchCapacityError({ code: "usage_limit" });
  if (
    !state ||
    state.refusal ||
    state.state !== "pending" ||
    state.active ||
    state.executorAttempts !== 0
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const { thread } = yield* input.client.request("thread/read", {
    threadId: input.nativeThreadId,
    includeTurns: false,
  });
  if (thread.modelProvider !== CODEX_POOL_NATIVE_PROVIDER)
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
});
