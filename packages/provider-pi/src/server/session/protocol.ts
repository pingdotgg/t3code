/**
 * Pi protocol failures raised while projecting RPC traffic.
 */
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { PI_PROVIDER } from "../adapter.ts";

export const protocolError = (detail: string, payload?: unknown) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: PI_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
