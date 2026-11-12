import * as Output from "alchemy/Output";

/** The Function attributes the helpers below read. */
export interface QualifiedFunctionRef {
  readonly functionArn: Output.Output<string>;
  readonly functionName: Output.Output<string>;
  readonly qualifiedArn: Output.Output<string>;
}

/** The alias ARN, when the Function routes through one. */
const aliasArnOf = (qualifiedArn: string | undefined, functionArn: string) =>
  // State written before `qualifiedArn` existed has no value for it.
  qualifiedArn !== undefined && qualifiedArn !== functionArn ? qualifiedArn : undefined;

/**
 * The ARN consumers should invoke `fn` through: its alias ARN when the
 * Function sets `alias`, otherwise the unqualified function ARN. Integration
 * URIs, notification targets and rule targets wire this instead of
 * `functionArn` so they follow the alias.
 */
export const qualifiedArnOf = (fn: QualifiedFunctionRef): Output.Output<string> =>
  Output.map(
    Output.all(fn.qualifiedArn, fn.functionArn),
    ([qualifiedArn, functionArn]: [string | undefined, string]) =>
      aliasArnOf(qualifiedArn, functionArn) ?? functionArn,
  );

/**
 * The `FunctionName` consumers should pass to Lambda APIs (event-source
 * mappings, `AddPermission`): the alias ARN when the Function sets `alias`,
 * otherwise the plain function name.
 */
export const qualifiedNameOf = (fn: QualifiedFunctionRef): Output.Output<string> =>
  Output.map(
    Output.all(fn.qualifiedArn, fn.functionArn, fn.functionName),
    ([qualifiedArn, functionArn, functionName]: [string | undefined, string, string]) =>
      aliasArnOf(qualifiedArn, functionArn) ?? functionName,
  );

/**
 * The `Qualifier` to start `fn`'s durable executions on: the alias name when
 * the Function sets `alias`, otherwise `$LATEST`.
 */
export const qualifierOf = (fn: QualifiedFunctionRef): Output.Output<string> =>
  Output.map(
    Output.all(fn.qualifiedArn, fn.functionArn),
    ([qualifiedArn, functionArn]: [string | undefined, string]) =>
      aliasArnOf(qualifiedArn, functionArn)?.slice(functionArn.length + 1) ?? "$LATEST",
  );
