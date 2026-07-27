import * as Effect from "effect/Effect";

import type { Input } from "../Input.ts";
import type { Environment } from "./Environment.ts";
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
   * Optional environment. When set every variable is scoped to that GitHub
   * Actions environment instead of the whole repository. Accepts an
   * environment name or a `GitHub.Environment` resource.
   */
  environment?: string | Environment;

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
 * @resource
 * @example
 * ```ts
 * yield* GitHub.Variables({
 *   owner: "my-org",
 *   repository: "my-repo",
 *   variables: {
 *     AWS_ROLE_ARN: role.roleArn,
 *     AWS_REGION: region,
 *   },
 * });
 * ```
 */
export const Variables = ({
  owner,
  repository,
  environment,
  variables,
}: VariablesProps) =>
  Effect.all(
    Object.entries(variables).map(([name, value]) =>
      Variable(name, {
        owner,
        repository,
        environment,
        name,
        value,
      }),
    ),
  );
