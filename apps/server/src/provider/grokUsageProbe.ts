import type { ServerProviderAuth } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "./acp/AcpSessionRuntime.ts";

const GROK_AUTH_CHECK_SUBSCRIPTION_METHOD = "_x.ai/auth/check_subscription";

export interface GrokAuthSubscriptionProbeResult {
  readonly authenticated: boolean;
  readonly email?: string;
  readonly subscriptionTier?: string;
  readonly authMode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseGrokAuthCheckSubscription(
  value: unknown,
): GrokAuthSubscriptionProbeResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const authenticated = value.authenticated === true;
  const meta = isRecord(value.meta) ? value.meta : undefined;
  const email = meta ? readTrimmedString(meta.email) : undefined;
  const subscriptionTier = meta ? readTrimmedString(meta.subscription_tier) : undefined;
  const authMode = meta ? readTrimmedString(meta.auth_mode) : undefined;

  return {
    authenticated,
    ...(email !== undefined ? { email } : {}),
    ...(subscriptionTier !== undefined ? { subscriptionTier } : {}),
    ...(authMode !== undefined ? { authMode } : {}),
  };
}

export function grokAuthMetadata(
  subscriptionTier: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  const tier = subscriptionTier?.trim();
  if (!tier) {
    return undefined;
  }
  return {
    type: tier,
    label: tier,
  };
}

export function grokAuthFromSubscriptionProbe(
  probe: GrokAuthSubscriptionProbeResult,
): ServerProviderAuth {
  if (!probe.authenticated) {
    return { status: "unauthenticated" };
  }

  const authMetadata = grokAuthMetadata(probe.subscriptionTier);
  return {
    status: "authenticated",
    ...(probe.email ? { email: probe.email } : {}),
    ...(authMetadata ? authMetadata : {}),
  };
}

export function probeGrokAuthViaAcp(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">;
  readonly sessionId: string;
}): Effect.Effect<GrokAuthSubscriptionProbeResult | undefined, EffectAcpErrors.AcpError> {
  return Effect.gen(function* () {
    const authRaw = yield* input.runtime
      .request(GROK_AUTH_CHECK_SUBSCRIPTION_METHOD, { sessionId: input.sessionId })
      .pipe(
        Effect.catchTags({
          AcpRequestError: () => Effect.void,
          AcpTransportError: () => Effect.void,
        }),
      );

    return parseGrokAuthCheckSubscription(authRaw);
  });
}
