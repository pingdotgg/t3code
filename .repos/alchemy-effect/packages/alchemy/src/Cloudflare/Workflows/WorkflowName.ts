import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { sha256 } from "../../Util/sha256.ts";

/**
 * Derive an account-global Workflow name from its unique host Worker name and
 * exported class. The hash preserves uniqueness when the readable prefix must
 * be truncated to Cloudflare's 64-character limit.
 *
 * @internal
 */
export const makeWorkflowName = (
  scriptName: Input<string>,
  className: string,
): Output.Output<string> => {
  const resolvedScriptName = Effect.isEffect(scriptName)
    ? scriptName.pipe(Effect.orDie)
    : scriptName;
  return Output.asOutput(
    resolvedScriptName as
      | string
      | Output.Output<string>
      | Effect.Effect<string>,
  ).pipe(
    Output.mapEffect((scriptName) => {
      const base = `${scriptName}-${className}`
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]/g, "-");
      return sha256(base).pipe(
        Effect.map((hash) => {
          const suffix = `-${hash.slice(0, 8)}`;
          // Trim trailing dashes left by mid-name truncation so the result
          // never contains a `--` seam.
          const head = base.slice(0, 64 - suffix.length).replace(/-+$/, "");
          return `${head}${suffix}`;
        }),
      );
    }),
  );
};
