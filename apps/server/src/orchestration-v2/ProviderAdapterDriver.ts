import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";

export class ProviderAdapterDriverCreateError extends Schema.TaggedErrorClass<ProviderAdapterDriverCreateError>()(
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
  readonly config: Config;
}

export interface ProviderAdapterDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly create: (
    input: ProviderAdapterDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderAdapterV2Shape, ProviderAdapterDriverCreateError, R | Scope.Scope>;
}

export type AnyProviderAdapterDriver<R = never> = ProviderAdapterDriver<any, R>;
