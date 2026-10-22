import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderDisabledInventory,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export class ProviderAdapterDriverCreateError extends Schema.TaggedError<ProviderAdapterDriverCreateError>()(
  "ProviderAdapterDriverCreateError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create orchestration-v2 provider adapter ${this.instanceId} (${this.driver}): ${this.detail}`;
  }
}

export interface ProviderAdapterDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  /** Absent when the driver does not support keeping inventory items out of T3. */
  readonly disabledInventory?: ProviderDisabledInventory;
  readonly config: Config;
}

export interface ProviderAdapterDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly create: (
    input: ProviderAdapterDriverCreateInput<Config>,
  ) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2["Service"],
    ProviderAdapterDriverCreateError,
    R | Scope.Scope
  >;
}

export type AnyProviderAdapterDriver<R = never> = ProviderAdapterDriver<any, R>;
