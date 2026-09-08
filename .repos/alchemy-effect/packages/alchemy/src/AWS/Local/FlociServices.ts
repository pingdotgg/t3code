/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Floci from "@alchemy.run/floci";
import type { FlociError } from "@alchemy.run/floci";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import type { Platform } from "../../Platform.ts";
import type { ResourceClassLike, ResourceLike } from "../../Resource.ts";
import { DEFAULT_LOCAL_ENDPOINT, LOCAL_ACCOUNT_ID } from "../AuthProvider.ts";
import * as Endpoint from "../Endpoint.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as Region from "../Region.ts";
import { provideProviderContext } from "./ProviderContext.ts";

/**
 * Fixed dummy account used for every floci-emulated resource. Attributes
 * computed from it (ARNs, queue URLs) double as proof that no real AWS
 * account was involved.
 */
export const FLOCI_ACCOUNT_ID = LOCAL_ACCOUNT_ID;

/** Region every floci-emulated resource lives in. */
export const FLOCI_REGION = "us-east-1";

// Annotated (not inferred): the inferred union names distilled's Endpoint
// through a non-portable relative path (TS2883), and consumers only ever
// hand this to `provideProviderContext`, which takes `Layer<any, any, never>`.
const makeFlociServices = (): Layer.Layer<any, FlociError, never> => {
  const region = FLOCI_REGION as RegionName;
  const resolved = {
    accessKeyId: Redacted.make("test"),
    secretAccessKey: Redacted.make("test"),
    sessionToken: undefined,
    region,
  };
  const credentials = Effect.succeed(resolved);
  return Layer.mergeAll(
    // Pin every distilled SDK call made by a wrapped lifecycle method to the
    // emulator gateway with dummy credentials in the emulator's region.
    Endpoint.of(DEFAULT_LOCAL_ENDPOINT),
    Region.of(FLOCI_REGION),
    Layer.succeed(Credentials, credentials),
    // Providers read `AWSEnvironment.current` inside lifecycle operations to
    // compute ARNs/attrs (accountId, region) — override it so computed
    // identities carry the dummy account and the emulator endpoint.
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: FLOCI_ACCOUNT_ID,
        region: FLOCI_REGION,
        credentials,
        endpoint: DEFAULT_LOCAL_ENDPOINT,
      }),
    ),
    // Building the services guarantees the emulator is serving: reuses
    // anything already listening on the endpoint, otherwise starts (or
    // revives) the managed `alchemy-floci` container and waits for health.
    Layer.effectDiscard(Floci.ensureFloci({ port: Floci.DEFAULT_FLOCI_PORT })),
  );
};

let flociServicesLayer: ReturnType<typeof makeFlociServices> | undefined;

/**
 * The floci-scoped override context for local-mode AWS providers, as a
 * **module-memoized layer reference** (see the note on
 * [Local/ProviderLayer.ts](../../Local/ProviderLayer.ts)): every
 * {@link flociDual} registration shares this one reference, so the stack
 * build's MemoMap constructs it — and runs `ensureFloci()` — exactly once
 * per stack build, and only when a local-mode provider is actually demanded.
 */
export const flociServices = () => (flociServicesLayer ??= makeFlociServices());

/**
 * Registers an AWS resource provider with both a **live** and a **local**
 * (floci-emulated) implementation via `ProviderLayer.dual`. The local
 * variant is the SAME live provider code with every lifecycle method
 * endpoint-wrapped to the floci emulator ({@link flociServices}), so
 * `alchemy dev` routes the resource to the emulator while `alchemy deploy`
 * (and `Alchemy.remote()` in dev) keeps hitting the real cloud.
 *
 * @example
 * ```ts
 * // in Providers.ts, replacing `S3.BucketProvider(),`:
 * flociDual(S3.Bucket, () => S3.BucketProvider()),
 * ```
 */
export const flociDual = <
  R extends ResourceLike,
  L extends Layer.Layer<any, any, any>,
>(
  cls:
    | ResourceClassLike<R>
    | Platform<R, any, any, any, any>
    | { Type: R["Type"] },
  live: () => L,
) =>
  ProviderLayer.dual(cls, {
    live,
    local: () => provideProviderContext(live(), flociServices()),
    // Registered as the resource's local data plane so deploy-time binding
    // clients (Action bodies, plan-time `execute`) route their API calls to
    // the emulator whenever the bound resource resolves to local mode.
    dataPlane: flociServices,
  });
