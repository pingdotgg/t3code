import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { plainJson } from "../internal/Observe.ts";
import type { Providers } from "../Providers.ts";
import type { WebFunctionAuthType } from "./WebFunctionEndpointSync.ts";

export const WebFunctionPermissionTypeId = "AWS.Lambda.WebFunctionPermission" as const;
export type WebFunctionPermissionTypeId = typeof WebFunctionPermissionTypeId;

/** The parts of an endpoint a permission grants access to. */
export interface WebFunctionEndpointRef {
  functionArn: string;
  endpointArn: string;
  authType: WebFunctionAuthType;
}

/**
 * A resource or its declaration (e.g. a `WebFunction` class), which is
 * yielded for you.
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface WebFunctionPermissionProps {
  /**
   * The endpoint callers may invoke: an `AWS.Lambda.WebFunction` (its
   * built-in endpoint), an `AWS.Lambda.WebFunctionEndpoint`, or a class
   * declaration of either. The endpoint must use `authType: "IamAuth"`;
   * an `ApplicationManaged` endpoint is public and ignores grants.
   */
  endpoint: Ref<WebFunctionEndpointRef>;
  /**
   * Who may invoke the endpoint: an AWS service principal (e.g.
   * `"cloudfront.amazonaws.com"`), an account ID, or an IAM role or user
   * ARN. Lambda rejects grants to an unspecified set of principals, so a
   * service principal needs `sourceArn`.
   */
  principal: string;
  /**
   * Restrict a service principal to one source, e.g. a CloudFront
   * distribution ARN.
   */
  sourceArn?: string;
}

export interface WebFunctionPermission extends Resource<
  WebFunctionPermissionTypeId,
  WebFunctionPermissionProps,
  {
    /** ARN of the Web Function whose resource policy holds the grant. */
    functionArn: string;
    /** ARN of the endpoint the grant applies to. */
    endpointArn: string;
    /** Statement ID of the grant in the function's resource policy. */
    statementId: string;
    /**
     * The grant's policy statement (principal, effect, action, resource and
     * conditions), as observed. Lets `alchemy drift` detect out-of-band
     * changes.
     */
    statement?: unknown;
  },
  never,
  Providers
> {}

/** Invoke grants only mean something on an `IamAuth` endpoint. */
export class WebFunctionEndpointNotIamAuth extends Data.TaggedError(
  "WebFunctionEndpointNotIamAuth",
)<{ endpointArn: string; message: string }> {}

export class WebFunctionPolicyInvalid extends Data.TaggedError("WebFunctionPolicyInvalid")<{
  functionArn: string;
  message: string;
}> {}

const WebFunctionPermissionResource = Resource<WebFunctionPermission>(WebFunctionPermissionTypeId);

const resolvePermissionProps = (
  props: WebFunctionPermissionProps | Effect.Effect<WebFunctionPermissionProps, never, Providers>,
): Effect.Effect<WebFunctionPermissionProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const endpoint = Effect.isEffect(resolved.endpoint)
      ? yield* resolved.endpoint
      : resolved.endpoint;
    return { ...resolved, endpoint };
  });

/**
 * Grants a principal `lambda:InvokeWebFunctionEndpoint` on one endpoint of
 * an `AWS.Lambda.WebFunction`.
 *
 * Use it for callers that sign requests with IAM: another AWS account's
 * role, or a service such as CloudFront scoped to one distribution. A
 * `CloudFront.Distribution` origin with `webFunction` creates this grant
 * for you. Each permission owns one statement in the function's resource
 * policy, so several permissions on one function coexist.
 *
 * ### Granting invoke access
 * **Example:** Let a role in another account call the endpoint
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "IamAuth",
 * });
 *
 * yield* AWS.Lambda.WebFunctionPermission("PartnerInvoke", {
 *   endpoint: api,
 *   principal: "arn:aws:iam::444455556666:role/partner-caller",
 * });
 * ```
 *
 * **Example:** Let one CloudFront distribution call the endpoint
 * ```typescript
 * yield* AWS.Lambda.WebFunctionPermission("CdnInvoke", {
 *   endpoint: api,
 *   principal: "cloudfront.amazonaws.com",
 *   sourceArn: distribution.distributionArn,
 * });
 * ```
 *
 * @resource
 */
export const WebFunctionPermission: typeof WebFunctionPermissionResource = Object.assign(
  (
    id: string,
    props: WebFunctionPermissionProps | Effect.Effect<WebFunctionPermissionProps, never, Providers>,
  ) => WebFunctionPermissionResource(id, resolvePermissionProps(props)),
  WebFunctionPermissionResource,
);

/** A declared `endpoint` resolves to the resource before the provider runs. */
const endpointOf = (props: WebFunctionPermissionProps): WebFunctionEndpointRef =>
  props.endpoint as WebFunctionEndpointRef;

interface PolicyStatement {
  Sid?: string;
  [key: string]: unknown;
}

interface PolicyDocument {
  Version?: string;
  Statement?: PolicyStatement[];
}

const isServicePrincipal = (principal: string) => principal.endsWith(".amazonaws.com");

const statementFor = (sid: string, props: WebFunctionPermissionProps): PolicyStatement => ({
  Sid: sid,
  Effect: "Allow",
  Principal: isServicePrincipal(props.principal)
    ? { Service: props.principal }
    : { AWS: props.principal },
  Action: "lambda:InvokeWebFunctionEndpoint",
  Resource: endpointOf(props).endpointArn,
  ...(props.sourceArn === undefined
    ? {}
    : { Condition: { StringEquals: { "aws:SourceArn": props.sourceArn } } }),
});

export const WebFunctionPermissionProvider = () =>
  Provider.effect(
    WebFunctionPermission,
    Effect.gen(function* () {
      /** Statement IDs allow letters and digits only. */
      const statementIdOf = (id: string) =>
        createPhysicalName({ id, maxLength: 100 }).pipe(
          Effect.map((name) => name.replaceAll(/[^A-Za-z0-9]/g, "")),
        );

      const getPolicy = Effect.fn(function* (functionArn: string) {
        const observed = yield* LambdaWeb.getResourcePolicy({ resourceArn: functionArn }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
        );
        if (observed === undefined) return undefined;
        const document = yield* Effect.try({
          try: () => JSON.parse(observed.policy) as PolicyDocument,
          catch: (cause) => new WebFunctionPolicyInvalid({ functionArn, message: String(cause) }),
        });
        return { document, revisionId: observed.revisionId };
      });

      /**
       * One lock per function: permissions in the same deploy reconcile
       * concurrently, and the first write to a function with no policy yet
       * has no `revisionId` to detect a conflict with.
       */
      const locks = new Map<string, Semaphore.Semaphore>();
      const lockFor = (functionArn: string) =>
        Effect.sync(() => {
          let lock = locks.get(functionArn);
          if (lock === undefined) {
            lock = Semaphore.makeUnsafe(1);
            locks.set(functionArn, lock);
          }
          return lock;
        });

      /**
       * Read-modify-write the function's single policy document, replacing
       * only this permission's statement. Writes to one function are
       * serialized; `revisionId` additionally makes a writer outside this
       * deploy fail with a conflict instead of being overwritten, and the
       * retry re-reads.
       */
      const updateStatement = (
        functionArn: string,
        sid: string,
        statement: PolicyStatement | undefined,
      ) =>
        Effect.flatMap(lockFor(functionArn), (lock) =>
          lock.withPermits(1)(writeStatement(functionArn, sid, statement)),
        );

      const writeStatement = (
        functionArn: string,
        sid: string,
        statement: PolicyStatement | undefined,
      ) =>
        Effect.gen(function* () {
          const current = yield* getPolicy(functionArn);
          const others = (current?.document.Statement ?? []).filter((s) => s.Sid !== sid);
          const existing = current?.document.Statement?.find((s) => s.Sid === sid);
          if (statement !== undefined && deepEqual(existing, statement)) return;
          if (statement === undefined && existing === undefined) return;
          const statements = statement === undefined ? others : [...others, statement];
          if (statements.length === 0) {
            yield* LambdaWeb.deleteResourcePolicy({
              resourceArn: functionArn,
              revisionId: current?.revisionId,
            });
            return;
          }
          yield* LambdaWeb.putResourcePolicy({
            resourceArn: functionArn,
            policy: JSON.stringify({
              Version: current?.document.Version ?? "2012-10-17",
              Statement: statements,
            }),
            ...(current ? { revisionId: current.revisionId } : {}),
          });
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "ConflictException",
            schedule: Schedule.spaced("1 second"),
            times: 10,
          }),
        );

      return {
        stables: ["functionArn", "statementId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (!output || !olds) return undefined;
          // The policy lives on the function: a different function is a new
          // grant.
          if (endpointOf(news).functionArn !== output.functionArn) {
            return { action: "replace" };
          }
          if (deepEqual(olds, news)) return { action: "noop" };
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionArn =
            output?.functionArn ?? (olds ? endpointOf(olds).functionArn : undefined);
          if (functionArn === undefined) return undefined;
          const sid = output?.statementId ?? (yield* statementIdOf(id));
          const policy = yield* getPolicy(functionArn);
          const statement = policy?.document.Statement?.find((s) => s.Sid === sid);
          if (statement === undefined) return undefined;
          return {
            functionArn,
            endpointArn: (statement.Resource as string) ?? output?.endpointArn ?? "",
            statementId: sid,
            statement: plainJson(statement),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const endpoint = endpointOf(news);
          if (endpoint.authType !== "IamAuth") {
            return yield* new WebFunctionEndpointNotIamAuth({
              endpointArn: endpoint.endpointArn,
              message: `AWS.Lambda.WebFunctionPermission "${id}": the endpoint uses authType "${endpoint.authType}", which is public and ignores invoke grants. Set authType: "IamAuth" on it.`,
            });
          }
          const sid = output?.statementId ?? (yield* statementIdOf(id));
          yield* updateStatement(endpoint.functionArn, sid, statementFor(sid, news));
          const policy = yield* getPolicy(endpoint.functionArn);
          const statement = policy?.document.Statement?.find((s) => s.Sid === sid);
          return {
            functionArn: endpoint.functionArn,
            endpointArn: endpoint.endpointArn,
            statementId: sid,
            statement: plainJson(statement ?? statementFor(sid, news)),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A deleted function takes its policy with it.
          yield* updateStatement(output.functionArn, output.statementId, undefined).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
