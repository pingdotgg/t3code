import type { ProviderRuntimeEvent, SubscriptionAllowance } from "@t3tools/contracts";
import { SubscriptionAllowanceProviderKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CLAUDE_SUBSCRIPTION_ALLOWANCE_UNAVAILABLE_MESSAGE =
  "Claude did not report subscription usage limits.";

export class ProviderAllowanceReadError extends Schema.TaggedErrorClass<ProviderAllowanceReadError>()(
  "ProviderAllowanceReadError",
  {
    provider: SubscriptionAllowanceProviderKind,
    instanceId: Schema.String,
    operation: Schema.Literals(["read", "timeout"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider allowance ${this.operation} failed (${this.provider}) for instance '${this.instanceId}'.`;
  }
}

/**
 * Optional live subscription reader owned by a materialized provider
 * instance. The service that aggregates these readers is intentionally
 * provider-agnostic; protocol details stay at the adapter boundary.
 */
export interface ProviderAllowanceReader {
  readonly provider: SubscriptionAllowanceProviderKind;
  readonly read: Effect.Effect<SubscriptionAllowance, ProviderAllowanceReadError>;
  /**
   * Maps a provider-native runtime update into a sparse allowance observation.
   * The lifecycle owns folding it into the last complete record.
   */
  readonly update?: (event: ProviderRuntimeEvent) => SubscriptionAllowance | undefined;
}
