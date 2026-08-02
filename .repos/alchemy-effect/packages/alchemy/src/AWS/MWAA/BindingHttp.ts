import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Environment } from "./Environment.ts";

/**
 * Shared scaffolding for Amazon MWAA HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate: every MWAA data-plane operation is scoped to one Airflow
 * {@link Environment}, whose name is injected as `Name`.
 *
 * MWAA distinguishes two IAM resource shapes:
 *
 * - Environment-scoped actions (`airflow:CreateCliToken`,
 *   `airflow:GetEnvironment`) are granted on the environment ARN
 *   `arn:{partition}:airflow:{region}:{account}:environment/{name}`.
 * - Airflow-RBAC-role-scoped actions (`airflow:CreateWebLoginToken`,
 *   `airflow:InvokeRestApi`) are granted on the Airflow role ARN
 *   `arn:{partition}:airflow:{region}:{account}:role/{name}/{airflow-role}` —
 *   MWAA maps the calling IAM identity to that Apache Airflow RBAC role.
 */

/**
 * Options for Airflow-RBAC-role-scoped bindings ({@link Environment} web
 * login tokens and Airflow REST API invocation).
 */
export interface AirflowRoleOptions {
  /**
   * The Apache Airflow RBAC role the IAM grant is scoped to — MWAA maps the
   * function's identity to this role when it calls the webserver. One of the
   * default Airflow roles (`Admin`, `Op`, `User`, `Viewer`, `Public`) or a
   * custom role defined in the environment.
   * @default "Admin"
   */
  airflowRole?: string;
}

/**
 * Build the impl Effect for an environment-scoped MWAA operation: the runtime
 * callable injects the bound {@link Environment}'s name as `Name` and the
 * deploy-time half grants `actions` on the environment ARN.
 */
export const makeMWAAEnvironmentHttpBinding = <
  I extends { Name: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MWAA.CreateCliToken`. */
  tag: string;
  /** The distilled operation; `Name` is injected from the environment. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the environment ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (environment: Environment) {
      const Name = yield* environment.environmentName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${environment}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${environment.arn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${environment.LogicalId})`)(function* (
        request?: Omit<I, "Name">,
      ) {
        return yield* op({ ...request, Name: yield* Name } as I);
      });
    });
  });

/**
 * Build the impl Effect for an Airflow-RBAC-role-scoped MWAA operation
 * (`CreateWebLoginToken`, `InvokeRestApi`): the runtime callable injects the
 * bound {@link Environment}'s name as `Name` and the deploy-time half grants
 * `actions` on the Airflow role ARN
 * `arn:{partition}:airflow:{region}:{account}:role/{name}/{airflowRole}` —
 * MWAA maps the function's IAM identity to that Apache Airflow RBAC role
 * (default `Admin`).
 */
export const makeMWAAAirflowRoleHttpBinding = <
  I extends { Name: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MWAA.InvokeRestApi`. */
  tag: string;
  /** The distilled operation; `Name` is injected from the environment. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the Airflow role ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (
      environment: Environment,
      roleOptions?: AirflowRoleOptions,
    ) {
      const Name = yield* environment.environmentName;
      const airflowRole = roleOptions?.airflowRole ?? "Admin";
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${environment}, ${airflowRole}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  // The environment ARN is
                  // `arn:{partition}:airflow:{region}:{account}:environment/{name}`;
                  // the Airflow RBAC role ARN swaps the resource type and
                  // appends the role.
                  Resource: [
                    environment.arn.pipe(
                      Output.map(
                        (arn) =>
                          `${arn.replace(":environment/", ":role/")}/${airflowRole}`,
                      ),
                    ),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${environment.LogicalId})`)(function* (
        request?: Omit<I, "Name">,
      ) {
        return yield* op({ ...request, Name: yield* Name } as I);
      });
    });
  });
