import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * The Amazon Inspector scan types that can be enabled per account.
 */
export type ResourceScanType =
  | "EC2"
  | "ECR"
  | "LAMBDA"
  | "LAMBDA_CODE"
  | "CODE_REPOSITORY";

/**
 * Raised when Inspector does not reach the requested scan state within the
 * provider's bounded convergence budget.
 */
export class Inspector2NotConverged extends Data.TaggedError(
  "Inspector2NotConverged",
)<{
  readonly accountId: string;
  readonly expected: string;
  readonly actual: Readonly<Record<string, string | undefined>>;
}> {}

export interface EnablerProps {
  /**
   * The resource scan types to enable for the account (e.g. `EC2`, `ECR`,
   * `LAMBDA`). Types managed by this resource are disabled again on destroy.
   */
  resourceTypes: ResourceScanType[];
}

/** @resource */
export interface Enabler extends Resource<
  "AWS.Inspector2.Enabler",
  EnablerProps,
  {
    /** The account the enabler applies to. */
    accountId: string;
    /** The scan types currently enabled and managed by this resource. */
    resourceTypes: string[];
    /** The overall Inspector account status (`ENABLED` / `DISABLED` / ...). */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Amazon Inspector account enablement — an account/region singleton that turns
 * on continuous vulnerability scanning for the selected resource types (EC2,
 * ECR, Lambda). Inspector exposes no tagging, so ownership is tracked by the
 * set of scan types this resource enabled; destroy only disables those types
 * and leaves any the account had enabled out-of-band untouched.
 *
 * @section Enabling Inspector
 * @example Enable EC2, ECR, and Lambda scanning
 * ```typescript
 * const inspector = yield* Inspector2.Enabler("Inspector", {
 *   resourceTypes: ["EC2", "ECR", "LAMBDA"],
 * });
 * ```
 */
const EnablerResource = Resource<Enabler>("AWS.Inspector2.Enabler");

export { EnablerResource as Enabler };

// The scan-type keys as they appear on the account's `resourceState`, mapped to
// their `EnableRequest` resource-type names.
const RESOURCE_STATE_KEYS = {
  ec2: "EC2",
  ecr: "ECR",
  lambda: "LAMBDA",
  lambdaCode: "LAMBDA_CODE",
  codeRepository: "CODE_REPOSITORY",
} as const;

const TYPE_TO_STATE_KEY: Record<string, keyof typeof RESOURCE_STATE_KEYS> = {
  EC2: "ec2",
  ECR: "ecr",
  LAMBDA: "lambda",
  LAMBDA_CODE: "lambdaCode",
  CODE_REPOSITORY: "codeRepository",
};

const statusOfType = (
  resourceState: inspector2.ResourceState | undefined,
  type: string,
): string | undefined => {
  const key = TYPE_TO_STATE_KEY[type];
  if (!resourceState || !key) return undefined;
  return resourceState[key]?.status;
};

const enabledTypes = (
  resourceState: inspector2.ResourceState | undefined,
): string[] => {
  if (!resourceState) return [];
  const out: string[] = [];
  for (const key of Object.keys(RESOURCE_STATE_KEYS) as Array<
    keyof typeof RESOURCE_STATE_KEYS
  >) {
    if (resourceState[key]?.status === "ENABLED") {
      out.push(RESOURCE_STATE_KEYS[key]);
    }
  }
  return out;
};

const statusesOf = (
  resourceState: inspector2.ResourceState | undefined,
  types: readonly string[],
): Record<string, string | undefined> =>
  Object.fromEntries(
    types.map((type) => [type, statusOfType(resourceState, type)]),
  );

export const EnablerProvider = () =>
  Provider.effect(
    EnablerResource,
    Effect.gen(function* () {
      const getAccount = (accountId: string) =>
        inspector2
          .batchGetAccountStatus({ accountIds: [accountId] })
          .pipe(Effect.map((r) => r.accounts?.[0]));

      // Inspector enablement can remain transitional for several minutes.
      // Keep the provider's wait bounded (~50s) and, critically, check the
      // terminal value because Effect.repeat returns its last success when the
      // repetition budget is exhausted even if `until` never became true.
      const waitUntilEnabled = Effect.fn(function* (
        accountId: string,
        types: readonly string[],
      ) {
        const account = yield* getAccount(accountId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (account) =>
              types.every(
                (t) => statusOfType(account?.resourceState, t) === "ENABLED",
              ),
            times: 10,
          }),
        );
        if (
          !types.every(
            (type) => statusOfType(account?.resourceState, type) === "ENABLED",
          )
        ) {
          return yield* Effect.fail(
            new Inspector2NotConverged({
              accountId,
              expected: "ENABLED",
              actual: statusesOf(account?.resourceState, types),
            }),
          );
        }
        return account;
      });

      const disableManagedTypes = Effect.fn(function* (
        accountId: string,
        types: readonly string[],
      ) {
        if (types.length === 0) return;

        let account = yield* getAccount(accountId);
        const enabling = types.filter(
          (type) => statusOfType(account?.resourceState, type) === "ENABLING",
        );
        if (enabling.length > 0) {
          yield* waitUntilEnabled(accountId, enabling);
          account = yield* getAccount(accountId);
        }

        // DISABLING and DISABLED are already converging toward deletion. Only
        // issue disable for types that are observably enabled.
        const enabled = types.filter(
          (type) => statusOfType(account?.resourceState, type) === "ENABLED",
        );
        if (enabled.length === 0) return;
        yield* inspector2
          .disable({ accountIds: [accountId], resourceTypes: enabled })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
      });

      return {
        read: Effect.fn(function* ({ output }) {
          const accountId =
            output?.accountId ?? (yield* AWSEnvironment.current).accountId;
          const account = yield* getAccount(accountId);
          if (!account) return undefined;
          const enabled = enabledTypes(account.resourceState);
          const managed = output
            ? output.resourceTypes.filter(
                (type) =>
                  statusOfType(account.resourceState, type) !== "DISABLED",
              )
            : enabled;
          if (managed.length === 0) return undefined;
          const attrs = {
            accountId,
            resourceTypes: managed,
            state: account.state?.status,
          };
          // Inspector has no tags. A live singleton without prior Alchemy
          // state is foreign and must be explicitly adopted.
          return output ? attrs : Unowned(attrs);
        }),

        // Inspector enablement is an account/region singleton keyed on the
        // caller's account. Report the single account status.
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const account = yield* getAccount(accountId);
            const enabled = enabledTypes(account?.resourceState);
            if (!account || enabled.length === 0) return [];
            return [
              {
                accountId,
                resourceTypes: enabled,
                state: account.state?.status,
              },
            ];
          }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const desired: string[] = news.resourceTypes ?? [];

          // 1. OBSERVE
          const account = yield* getAccount(accountId);
          const currentlyEnabled = enabledTypes(account?.resourceState);

          // 2. ENSURE — enable any desired type not yet enabled.
          const toEnable = desired.filter(
            (type) =>
              !currentlyEnabled.includes(type) &&
              statusOfType(account?.resourceState, type) !== "ENABLING",
          );
          if (toEnable.length > 0) {
            yield* inspector2.enable({
              accountIds: [accountId],
              resourceTypes: toEnable,
            });
          }

          // Wait for the desired types to reach the terminal ENABLED state
          // before returning — otherwise a follow-up destroy would be rejected
          // with ENABLE_IN_PROGRESS.
          if (desired.some((type) => !currentlyEnabled.includes(type))) {
            yield* waitUntilEnabled(accountId, desired);
          }

          // 3. SYNC — disable any type we previously managed but no longer want.
          // Disable teardown is slow (minutes); fire it and do not block, the
          // account converges to the desired set asynchronously.
          const previouslyManaged = output?.resourceTypes ?? [];
          const noLongerManaged = previouslyManaged.filter(
            (type) => !desired.includes(type),
          );
          yield* disableManagedTypes(accountId, noLongerManaged);

          const final = yield* getAccount(accountId);
          const managed = [
            ...new Set([
              ...previouslyManaged.filter((type) => desired.includes(type)),
              ...toEnable,
            ]),
          ];
          yield* session.note(accountId);
          return {
            accountId,
            resourceTypes: managed,
            state: final?.state?.status,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* disableManagedTypes(output.accountId, output.resourceTypes);
        }),
      };
    }),
  );
