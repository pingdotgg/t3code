import * as Effect from "effect/Effect";

/**
 * Generate an instance ID: a 16-byte (128-bit) random hex-encoded string that
 * identifies one physical instance of a logical resource. The running
 * resource's instance ID is available as `ResourceContext.instanceId`.
 * @returns Hex-encoded instance ID (16 random bytes)
 */
export const generateInstanceId = () =>
  Effect.sync(() => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
