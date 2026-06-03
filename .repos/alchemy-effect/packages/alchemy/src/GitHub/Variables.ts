import * as Effect from "effect/Effect";

import type { Input } from "../Input.ts";
import { Variable } from "./Variable.ts";

export interface VariablesProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Map of variable name to value. Each entry becomes one
   * `GitHub.Variable` resource, using the map key as both the alchemy
   * logical id and the variable name.
   */
  variables: Record<string, Input<string>>;
}

/**
 * Bulk-creates a set of {@link Variable}s in the same repository.
 *
 * Plural counterpart of {@link import("./Secrets.ts").Secrets}, for
 * non-sensitive values like region names, role ARNs, environment labels,
 * or feature flags.
 *
 * @example
 * ```ts
 * yield* GitHub.Variables({
 *   owner: "alchemy-run",
 *   repository: "alchemy-effect",
 *   variables: {
 *     AWS_ROLE_ARN: role.roleArn,
 *     AWS_REGION: region,
 *   },
 * });
 * ```
 */
export const Variables = ({ owner, repository, variables }: VariablesProps) =>
  Effect.all(
    Object.entries(variables).map(([name, value]) =>
      Variable(name, {
        owner,
        repository,
        name,
        value,
      }),
    ),
  );
