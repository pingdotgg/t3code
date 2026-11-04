import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Application } from "./Application.ts";

/**
 * Shared scaffolding for the Amazon EMR Serverless HTTP bindings.
 *
 * Every EMR Serverless data-plane operation is addressed by an
 * `applicationId`, so every binding is scoped to a bound {@link Application}:
 * the deploy-time half grants `actions` on the application's ARN (plus any
 * `subresources` wildcards — job runs and sessions are authorized against
 * `{applicationArn}/jobruns/*` / `{applicationArn}/sessions/*` sub-resource
 * ARNs), and the runtime half injects the application's id into every
 * request. Operations that hand the service an execution role to assume
 * (`StartJobRun`, `StartSession`) additionally grant `iam:PassRole`
 * conditioned to `emr-serverless.amazonaws.com`.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeEmrServerlessHttpBinding({ … }))`.
 */
export const makeEmrServerlessHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EMRServerless.StartJobRun`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the application ARN (+ `subresources`). */
  actions: readonly string[];
  /**
   * Sub-resource wildcards additionally granted below the application ARN,
   * e.g. `"/jobruns/*"` for job-run-addressed actions.
   */
  subresources?: readonly string[];
  /**
   * Grant `iam:PassRole` (conditioned to `emr-serverless.amazonaws.com`) so
   * the function can hand the service the execution role a job run or
   * session assumes. Set on `StartJobRun` and `StartSession`.
   */
  passRole?: boolean;
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(options.operation);

    return Effect.fn(function* (application: Application) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const ApplicationId = yield* application.applicationId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const passRoleStatements: PolicyStatement[] = options.passRole
          ? [
              {
                Effect: "Allow",
                Action: ["iam:PassRole"],
                Resource: ["*"],
                Condition: {
                  StringEquals: {
                    "iam:PassedToService": "emr-serverless.amazonaws.com",
                  },
                },
              },
            ]
          : [];
        yield* bind`${options.tag}(${application})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: [
                Output.interpolate`${application.applicationArn}`,
                ...(options.subresources ?? []).map(
                  (suffix) => Output.interpolate`${application.applicationArn}${suffix}`,
                ),
              ],
            },
            ...passRoleStatements,
          ],
        });
      }
      return Effect.fn(`${options.tag}(${application.LogicalId})`)(function* (
        request?: Omit<I, "applicationId" | "clientToken">,
      ) {
        return yield* op({
          ...request,
          applicationId: yield* ApplicationId,
        } as I);
      });
    });
  });
