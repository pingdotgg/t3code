import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  listInstances,
  resolveInstance,
  retryIdentityCenter,
  toInstanceAttributes,
} from "./common.ts";

export interface InstanceProps {
  /**
   * Explicit instance ARN to adopt.
   */
  instanceArn?: string;
  /**
   * Friendly instance name.
   *
   * When `mode` is `"account"`, this name is passed to `CreateInstance`.
   * When `mode` is `"existing"`, it is used only for discovery.
   */
  name?: string;
  /**
   * How Alchemy should satisfy this resource.
   *
   * `existing` adopts a visible instance and fails if none is found.
   * `account` creates an account instance when no visible instance matches.
   *
   * Organization instances cannot currently be enabled via public API, so
   * organization-management-account deployments should use `existing`.
   *
   * @default "existing"
   */
  mode?: "existing" | "account";
}

export interface Instance extends Resource<
  "AWS.IdentityCenter.Instance",
  InstanceProps,
  {
    instanceArn: string;
    identityStoreId: string;
    ownerAccountId: string | undefined;
    name: string | undefined;
    status: string | undefined;
    statusReason: string | undefined;
    createdDate: Date | undefined;
    mode: "existing" | "account";
  },
  never,
  Providers
> {}

/**
 * An IAM Identity Center instance visible to the current account.
 *
 * Use `mode: "existing"` to adopt a pre-enabled organization instance. Use
 * `mode: "account"` only for standalone or member-account account instances.
 *
 * @section Discovering Existing Instances
 * @example Adopt An Existing Instance
 * ```typescript
 * const instance = yield* Instance("IdentityCenter", {
 *   mode: "existing",
 * });
 * ```
 *
 * @section Creating Account Instances
 * @example Create A Member Account Instance
 * ```typescript
 * const instance = yield* Instance("IdentityCenter", {
 *   mode: "account",
 *   name: "customer-a",
 * });
 * ```
 */
export const Instance = Resource<Instance>("AWS.IdentityCenter.Instance");

export const InstanceProvider = () =>
  Provider.effect(
    Instance,
    Effect.gen(function* () {
      return {
        stables: ["instanceArn", "identityStoreId", "ownerAccountId", "mode"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.instanceArn !== news.instanceArn ||
            olds?.mode !== news.mode ||
            olds?.name !== news.name
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const mode = output?.mode ?? olds?.mode ?? "existing";
          const instance = yield* readInstance({
            instanceArn: output?.instanceArn ?? olds?.instanceArn,
            name: olds?.name,
          });
          return instance ? { ...instance, mode } : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const mode = output?.mode ?? news.mode ?? "existing";

          // Observe — try to find a visible instance, preferring an
          // explicit ARN (from output or props) and otherwise scanning
          // the account.
          const existing = yield* readInstance({
            instanceArn: output?.instanceArn ?? news.instanceArn,
            name: news.name,
          });
          if (existing) {
            yield* session.note(existing.instanceArn);
            return {
              ...existing,
              mode,
            };
          }

          // Ensure — for `existing` mode we cannot create one; fail.
          // Organization instances must be enabled manually in the
          // management account.
          if (mode !== "account") {
            return yield* Effect.fail(
              new Error(
                "No visible Identity Center instance was found. Organization instances must be enabled manually in the management account before Alchemy can adopt them.",
              ),
            );
          }

          // Ensure — `account` mode creates an account instance.
          const response = yield* retryIdentityCenter(
            ssoAdmin.createInstance({
              Name: news.name,
            }),
          );

          const created = yield* readInstance({
            instanceArn: response.InstanceArn,
            name: news.name,
          });
          if (!created) {
            return yield* Effect.fail(
              new Error(
                "failed to resolve Identity Center instance after create",
              ),
            );
          }

          yield* session.note(created.instanceArn);
          return {
            ...created,
            mode,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.mode !== "account") {
            return;
          }

          const existing = yield* readInstance({
            instanceArn: output.instanceArn,
          });
          if (!existing) {
            return;
          }

          yield* retryIdentityCenter(
            ssoAdmin.deleteInstance({
              InstanceArn: output.instanceArn,
            }),
          );
        }),
      };
    }),
  );

const readInstance = Effect.fn(function* ({
  instanceArn,
  name,
}: Pick<InstanceProps, "instanceArn" | "name">) {
  if (instanceArn) {
    const instance = yield* resolveInstance(instanceArn).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return instance ? toInstanceAttributes(instance) : undefined;
  }

  const instances = yield* listInstances();
  const match =
    instances.find((instance) => instance.Name === name) ??
    (instances.length === 1 ? instances[0] : undefined) ??
    instances.find((instance) => instance.Status === "ACTIVE");

  return match?.InstanceArn && match.IdentityStoreId
    ? toInstanceAttributes(match)
    : undefined;
});
