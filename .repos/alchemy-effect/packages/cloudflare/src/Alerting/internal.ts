import * as alerting from "@distilled.cloud/cloudflare/alerting";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { AlertType, NotificationPolicyMechanisms } from "./NotificationPolicy.ts";

// Notification-policy plumbing shared by NotificationPolicy and CustomAlert.

export interface ObservedPolicy {
  readonly id: string;
  readonly name?: string;
  readonly alertType?: AlertType;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly alertInterval?: string;
  readonly mechanisms?: unknown;
  readonly filters?: unknown;
  readonly created?: string;
  readonly modified?: string;
}

export const undef = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

export const narrowPolicy = (raw: {
  id?: string | null;
  name?: string | null;
  alertType?: string | null;
  enabled?: boolean | null;
  description?: string | null;
  alertInterval?: string | null;
  mechanisms?: unknown;
  filters?: unknown;
  created?: string | null;
  modified?: string | null;
}): ObservedPolicy | undefined =>
  raw.id == null
    ? undefined
    : {
        id: raw.id,
        name: undef(raw.name),
        alertType: undef(raw.alertType) as AlertType | undefined,
        enabled: undef(raw.enabled),
        description: undef(raw.description),
        alertInterval: undef(raw.alertInterval),
        mechanisms: raw.mechanisms ?? undefined,
        filters: raw.filters ?? undefined,
        created: undef(raw.created),
        modified: undef(raw.modified),
      };

export const observePolicy = (accountId: string, policyId: string) =>
  alerting.getPolicy({ accountId, policyId }).pipe(
    Effect.map((p) => narrowPolicy({ ...p, id: p.id ?? policyId })),
    Effect.catchTag("PolicyNotFound", () => Effect.undefined),
  );

export const findPolicyByName = (accountId: string, name: string) =>
  alerting.listPolicies.items({ accountId }).pipe(
    Stream.filter((p) => p.name === name && p.id != null),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.map((p) => (p === undefined ? undefined : narrowPolicy(p))),
  );

export const createPolicyName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

export type PolicyBody = Omit<alerting.CreatePolicyRequest, "accountId">;

/**
 * Binding contract of a notification policy (`NotificationPolicy`,
 * `CustomAlert`): destinations contributed by the runtimes that consume its
 * notifications, e.g. `Cloudflare.Alerting.consumeNotifications`.
 */
export interface NotificationPolicyBinding {
  /** Webhook destinations to notify, alongside the declared `mechanisms`. */
  webhooks?: ReadonlyArray<{ id: string }>;
}

/**
 * The declared mechanisms plus the webhooks bound onto the policy. The engine
 * sid-sorts bindings, so the merged order is stable across deploys.
 */
export const boundMechanisms = (
  mechanisms: NotificationPolicyMechanisms | undefined,
  bindings: ReadonlyArray<{ data: NotificationPolicyBinding }>,
): PolicyBody["mechanisms"] => {
  const bound = bindings.flatMap((b) => b.data.webhooks ?? []);
  if (bound.length === 0) return mechanisms as PolicyBody["mechanisms"];
  const webhooks = [...(mechanisms?.webhooks ?? []), ...bound];
  return {
    ...mechanisms,
    webhooks: webhooks.filter((w, i) => webhooks.findIndex((x) => x.id === w.id) === i),
  } as PolicyBody["mechanisms"];
};

export const policyEqualsObserved = (desired: PolicyBody, observed: ObservedPolicy): boolean =>
  desired.name === (observed.name ?? "") &&
  desired.enabled === (observed.enabled ?? true) &&
  (desired.description ?? "") === (observed.description ?? "") &&
  (desired.alertInterval ?? undefined) === observed.alertInterval &&
  normalizedEquals(desired.mechanisms, observed.mechanisms) &&
  normalizedEquals(desired.filters, observed.filters);

export const normalizedEquals = (a: unknown, b: unknown): boolean =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/** Drop null/undefined members and sort object keys for stable comparison. */
export const normalize = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = normalize((value as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
};
