import * as Context from "effect/Context";
import { fallbackCf } from "./CfOptions.shared.ts";

export * from "./CfOptions.shared.ts";

/**
 * The `request.cf` object exposed to user workers, defaulting to
 * {@link fallbackCf} (Miniflare's static placeholder blob). Override via
 * layer to simulate different geolocation or TLS properties:
 *
 * ```ts
 * Layer.succeed(Cf.Cf, { ...Cf.fallbackCf, country: "GB" })
 * ```
 *
 * Requests carrying an `MF-CF-Blob` header bypass this value; the header's
 * JSON is used verbatim.
 */
export const Cf = Context.Reference("cloudflare-runtime/Cf", {
  defaultValue: (): Record<string, unknown> => fallbackCf,
});
