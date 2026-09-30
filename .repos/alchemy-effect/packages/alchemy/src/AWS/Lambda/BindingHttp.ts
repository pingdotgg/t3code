import type {
  AwsCredentialProviderError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Output as OutputType } from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import { DEFAULT_LOCAL_ENDPOINT } from "../AuthProvider.ts";
import { Credentials, makeAssumeRoleResolver } from "../Credentials.ts";
import { AccessKey } from "../IAM/AccessKey.ts";
import { Role } from "../IAM/Role.ts";
import { User } from "../IAM/User.ts";
import type { Function } from "./Function.ts";
import { isBindingHost } from "./Function.ts";

/**
 * Shared scaffolding for AWS Lambda control/data-plane HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the granted ARNs is boilerplate. The MicroVM family
 * (`MicrovmBinding.ts`) shares only the cross-cloud host handling.
 */

// ---------------------------------------------------------------------------
// Cross-cloud host: a Cloudflare Worker reaching AWS.
//
// A Lambda host grants on its execution role and its credentials are ambient.
// A Worker has neither, so a binding on a Worker declares an IAM User +
// AccessKey + a least-privilege Role (the engine de-dupes these by logical id,
// so every binding on the host shares one identity), binds the key and role
// ARN onto the Worker, and assumes the role at runtime through the
// single-flight, expiry-aware resolver from `Credentials.ts`.
// ---------------------------------------------------------------------------

// The Worker is recognised structurally by its Type id so this module never
// imports the Cloudflare module graph.
const WORKER_TYPE_ID = "Cloudflare.Worker";
export type WorkerHost = ResourceLike & {
  bind: (
    template: TemplateStringsArray,
    ...args: unknown[]
  ) => (binding: Input<{ bindings?: unknown[] }>) => Effect.Effect<void>;
};
export const isWorkerHost = (host: ResourceLike): host is WorkerHost =>
  (host as { Type?: string }).Type === WORKER_TYPE_ID;

/** Region segment of an AWS ARN (`arn:partition:service:<region>:...`). */
export const regionFromArn = (arn: string): string =>
  arn.split(":")[3] ?? "us-east-1";

export interface WorkerAwsAccess {
  /** The least-privilege Role each binding contributes statements to. */
  readonly role: Role;
  /** Assumed-role credentials, cached and refreshed near expiry. */
  readonly credentials: Effect.Effect<
    ResolvedCredentials,
    AwsCredentialProviderError
  >;
}

/**
 * The IAM identity a Cloudflare Worker uses to reach AWS: `${id}User` holding
 * `${id}AccessKey`, allowed to assume `${id}Role`, which every binding on the
 * Worker grants its statements to. Yielding the key and role attributes
 * registers them on the Worker at deploy and reads them from its env at
 * runtime, so the declarations run in both phases.
 */
export const workerAwsAccess = Effect.fn(function* (host: WorkerHost) {
  const id = host.LogicalId;
  // Yielding a resource class gives a constructor whose providers are the
  // host stack's (the same way the Cloudflare `*Http` bindings mint tokens).
  const IamUser = yield* User;
  const IamAccessKey = yield* AccessKey;
  const IamRole = yield* Role;

  // The user may assume any role that trusts it; the role's trust policy is
  // what restricts assumption to this user, which avoids a User↔Role ARN
  // dependency cycle.
  const user = yield* IamUser(`${id}User`, {
    inlinePolicies: {
      AssumeRole: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["*"] },
        ],
      },
    },
  });
  const accessKey = yield* IamAccessKey(`${id}AccessKey`, {
    userName: user.userName,
  });
  const role = yield* IamRole(`${id}Role`, {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: user.userArn },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
  });

  // Local dev: STS and the bound operations run on the emulator, reached via
  // the same `AWS_ENDPOINT_URL` the emulator injects into Lambda containers
  // (read at runtime by `Endpoint.fromEnv()` below).
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const context = yield* Effect.serviceOption(AlchemyContext);
    if (Option.isSome(context) && context.value.dev) {
      yield* host.bind`${id}Endpoint`({
        bindings: [
          {
            type: "plain_text",
            name: "AWS_ENDPOINT_URL",
            text: DEFAULT_LOCAL_ENDPOINT,
          },
        ],
      });
    }
  }

  const accessKeyId = yield* accessKey.accessKeyId;
  const secretAccessKey = yield* accessKey.secretAccessKey;
  const roleArn = yield* role.roleArn;

  // The long-lived user credentials that sign `AssumeRole`, read from the
  // Worker env on each refresh (not captured: at deploy the env is empty).
  const base = Layer.succeed(
    Credentials,
    Effect.gen(function* () {
      const id = yield* accessKeyId;
      const secret = yield* secretAccessKey;
      return {
        accessKeyId: Redacted.make(id),
        secretAccessKey: secret
          ? Redacted.isRedacted(secret)
            ? secret
            : Redacted.make(secret)
          : Redacted.make(""),
        sessionToken: undefined,
        // STS is global; operations provide their own Region per call.
        region: "us-east-1",
      } satisfies ResolvedCredentials;
    }),
  );
  const credentials = yield* makeAssumeRoleResolver({
    roleArn,
    base,
    region: "us-east-1",
  });
  return { role, credentials } satisfies WorkerAwsAccess;
});

/**
 * What a binding grants its host: the IAM statements, under a label that
 * names the grant. Built only at deploy.
 */
export interface HostGrant {
  readonly label: string;
  readonly policyStatements: Input<PolicyStatement>[];
}

/**
 * Resolve how this binding's host reaches AWS and grant it `grant()`.
 *
 * A Lambda-like host has ambient credentials and takes the statements on its
 * execution role, so the result is `undefined`. A Cloudflare Worker gets a
 * {@link WorkerAwsAccess}, whose role takes the statements. The identity is
 * needed at runtime (it is where the credentials come from); the grant is
 * deploy-only and sits behind the one `__ALCHEMY_RUNTIME__` guard so the
 * bundler drops it from the Worker.
 */
export const hostAwsAccess = Effect.fn(function* (
  host: ResourceLike | undefined,
  grant: () => HostGrant,
) {
  const access =
    host !== undefined && isWorkerHost(host)
      ? yield* workerAwsAccess(host)
      : undefined;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const grantee = isBindingHost(host) ? host : access?.role;
    if (grantee !== undefined) {
      const { label, policyStatements } = grant();
      yield* grantee.bind`${label}`({ policyStatements });
    }
  }
  return access;
});

/**
 * Run an operation with host-appropriate AWS credentials: on a Lambda host
 * they are ambient (`access` undefined); on a Worker host provide the assumed
 * role, the operation's `Region`, the env endpoint override and an HttpClient.
 */
export const withRuntimeCredentials = <A, E>(
  access: WorkerAwsAccess | undefined,
  region: Effect.Effect<string>,
  eff: Effect.Effect<A, E, any>,
): Effect.Effect<A, E, any> =>
  access
    ? Effect.flatMap(region, (reg) =>
        eff.pipe(
          Effect.provide(
            Layer.succeed(Credentials, access.credentials).pipe(
              Layer.provideMerge(Layer.succeed(Region, Effect.succeed(reg))),
              Layer.provideMerge(Endpoint.fromEnv()),
              Layer.provideMerge(FetchHttpClient.layer),
            ),
          ),
        ),
      )
    : eff;

/**
 * Build the impl Effect for a function-scoped operation (`Invoke`,
 * `GetFunction`, `InvokeWithResponseStream`): the runtime callable injects
 * the bound {@link Function}'s ARN as `FunctionName` and the deploy-time
 * half grants `actions` on `resources` (default: the function ARN).
 */
export const makeFunctionHttpBinding = <
  I extends { FunctionName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Lambda.GetFunction`. */
  tag: string;
  /**
   * The distilled operation, called per request; `FunctionName` is injected
   * from the function. Its requirements (`Credentials`, `HttpClient`) are
   * ambient on a Lambda host and provided around each call on a Worker host.
   */
  operation: (input: I) => Effect.Effect<A, E, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the function ARN */
  resources?: (func: Function) => (string | OutputType<string>)[];
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* (func: Function) {
      const FunctionArn = yield* func.functionArn;
      const host = yield* Binding.Host;
      const access = yield* hostAwsAccess(host, () => ({
        label: `Allow(${host?.LogicalId}, ${options.tag}(${func.LogicalId}))`,
        policyStatements: [
          {
            Effect: "Allow",
            Action: [...options.actions],
            Resource: options.resources?.(func) ?? [func.functionArn],
          },
        ],
      }));
      const region = Effect.map(FunctionArn, regionFromArn);
      return Effect.fn(`${options.tag}(${func.LogicalId})`)(function* (
        request?: Omit<I, "FunctionName">,
      ) {
        const FunctionName = yield* FunctionArn;
        return yield* withRuntimeCredentials(
          access,
          region,
          options.operation({ ...request, FunctionName } as I),
        ) as Effect.Effect<A, E>;
      });
    });
  });

/**
 * Build the impl Effect for an account-level operation
 * (`GetAccountSettings`, `ListFunctions`): the runtime callable passes the
 * caller's request through unchanged and the deploy-time half grants
 * `actions` on `*` (these Lambda actions do not support resource-level
 * permissions).
 */
export const makeLambdaAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Lambda.ListFunctions`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
