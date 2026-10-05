import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

/** KeyRing and CryptoKey ids match `[a-zA-Z0-9_-]{1,63}`. */
export const MAX_KMS_ID_LENGTH = 63;

const VARIANT_LENGTH = 8;

/**
 * Deterministic default id for a KMS key ring or key:
 * `{stack}-{logicalId}-{stage}`, with no per-create instance suffix.
 *
 * Cloud KMS never deletes key rings, and a deleted key's name is retired
 * forever, so an instance-suffixed default leaks a new ring/key on every
 * destroy/redeploy cycle. A stable name lets the next deploy of the same
 * logical resource reclaim what the previous one left behind.
 *
 * `variant` (e.g. the key's immutable settings) appends a short hash so a
 * replacement triggered by a change to those settings gets a distinct name
 * and never collides with the generation it replaces.
 */
export const deterministicKmsId = (id: string, variant?: unknown) =>
  Effect.gen(function* () {
    const suffix =
      variant === undefined
        ? ""
        : `-${yield* Effect.sync(() =>
            createHash("sha256")
              .update(JSON.stringify(variant))
              .digest("hex")
              .slice(0, VARIANT_LENGTH),
          )}`;
    const base = yield* createPhysicalName({
      id,
      instanceId: "",
      suffixLength: 0,
      maxLength: MAX_KMS_ID_LENGTH - suffix.length,
      lowercase: true,
    });
    return `${base.replace(/-+$/, "")}${suffix}`;
  });
