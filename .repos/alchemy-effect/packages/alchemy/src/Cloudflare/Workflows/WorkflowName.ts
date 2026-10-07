import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { sha256 } from "../../Util/sha256.ts";

/**
 * Lift a script-name input (a literal, an Output, or a Config/Effect-valued
 * name) into an Output so it can feed plan-time derivations.
 *
 * @internal
 */
export const asScriptNameOutput = (
  scriptName: Input<string>,
): Output.Output<string> =>
  Output.asOutput(
    (Effect.isEffect(scriptName)
      ? scriptName.pipe(Effect.orDie)
      : scriptName) as string | Output.Output<string> | Effect.Effect<string>,
  );

/**
 * Derive an account-global Workflow name from a resolved host Worker name and
 * exported class.
 *
 * @internal
 */
export const generateWorkflowName = Effect.fn(function* (
  scriptName: string,
  className: string,
) {
  const base = `${scriptName}-${className}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-");
  const hash = yield* sha256(base);
  const suffix = `-${hash.slice(0, 8)}`;
  // Trim trailing dashes left by mid-name truncation so the result never
  // contains a `--` seam.
  const head = base.slice(0, 64 - suffix.length).replace(/-+$/, "");
  return `${head}${suffix}`;
});

/**
 * Derive an account-global Workflow name when the host Worker name may still
 * be an unresolved input.
 *
 * @internal
 */
export const makeWorkflowName = (
  scriptName: Input<string>,
  className: string,
): Output.Output<string> =>
  asScriptNameOutput(scriptName).pipe(
    Output.mapEffect((scriptName) =>
      generateWorkflowName(scriptName, className),
    ),
  );
