import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import type { Environment } from "./Environment.ts";
import { Secret } from "./Secret.ts";

export interface SecretsProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Optional environment. When set every secret is scoped to that GitHub
   * Actions environment instead of the whole repository. Accepts an
   * environment name or a `GitHub.Environment` resource.
   */
  environment?: string | Environment;

  /**
   * Map of secret name to value. Plain strings are wrapped with
   * `Redacted.make`; already-redacted values are passed through.
   */
  secrets: Record<string, Input<string | Redacted.Redacted<string>>>;
}

/**
 * Bulk-creates a set of {@link Secret}s in the same repository (and
 * optionally the same environment).
 *
 * Each entry in `secrets` becomes one `GitHub.Secret` resource, using the
 * map key as both the alchemy logical id and the secret name.
 * @resource
 * @example
 * ```ts
 * yield* GitHub.Secrets({
 *   owner: "my-org",
 *   repository: "my-repo",
 *   secrets: {
 *     AXIOM_INGEST_TOKEN: tokenValue,
 *     AXIOM_DATASET_TRACES: traces.name,
 *   },
 * });
 * ```
 */
export const Secrets = ({
  owner,
  repository,
  environment,
  secrets,
}: SecretsProps) =>
  Effect.all(
    Object.entries(secrets).map(([name, value]) =>
      Secret(name, {
        owner,
        repository,
        environment,
        name,
        value: liftValue(value),
      }),
    ),
  );

// Accepts a plain string, an existing `Redacted<string>`, or a lazy `Input`
// of either. We must lift through lazy inputs so the inner string gets wrapped
// after the engine resolves it — otherwise `Redacted.make(input)` produces an
// opaque `Redacted<Config | Effect | Output>` that the plan cannot resolve.
const liftValue = (
  value: Input<string | Redacted.Redacted<string>>,
): Input<Redacted.Redacted<string>> =>
  Config.isConfig(value)
    ? Config.map(value, toRedacted)
    : Effect.isEffect(value)
      ? Effect.map(value, toRedacted)
      : Output.isOutput(value)
        ? Output.map(
            value as Output.Output<string | Redacted.Redacted<string>>,
            toRedacted,
          )
        : toRedacted(value as string | Redacted.Redacted<string>);

const toRedacted = (
  value: string | Redacted.Redacted<string>,
): Redacted.Redacted<string> =>
  Redacted.isRedacted(value)
    ? (value as Redacted.Redacted<string>)
    : Redacted.make(value);
