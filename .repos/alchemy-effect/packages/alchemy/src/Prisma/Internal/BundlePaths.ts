import * as Effect from "effect/Effect";

/** Validate an untrusted bundler output path before writing it to disk. */
export const normalizeBundleFilePath = (input: string) =>
  Effect.gen(function* () {
    const normalized = input.replaceAll("\\", "/");
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      /^[a-zA-Z]:\//.test(normalized)
    ) {
      return yield* Effect.fail(
        new Error(`Invalid Compute bundle output path: ${input}`),
      );
    }
    const segments = normalized.split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      return yield* Effect.fail(
        new Error(`Invalid Compute bundle output path: ${input}`),
      );
    }
    return segments.join("/");
  });
