// Compatibility shim for the intentionally excluded orchestration harness.
import * as Layer from "effect/Layer";

import * as ProviderService from "../ProviderService.ts";

export type ProviderServiceLiveOptions = ProviderService.ProviderServiceOptions;

export const ProviderServiceLive = ProviderService.layer;

export const makeProviderServiceLive = (options?: ProviderService.ProviderServiceOptions) =>
  Layer.effect(ProviderService.ProviderService, ProviderService.make(options));
