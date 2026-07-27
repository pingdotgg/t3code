import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { normalizeDurationInput } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import { resolveInstance, retryIdentityCenter } from "./common.ts";

export interface PermissionSetProps {
  /**
   * Explicit IAM Identity Center instance ARN.
   * If omitted, Alchemy adopts the only visible instance.
   */
  instanceArn?: string;
  /**
   * Permission set name.
   */
  name: string;
  /**
   * Optional human-readable description.
   */
  description?: string;
  /**
   * Optional session duration, e.g. `"8 hours"` or `Duration.hours(8)`.
   * Sent to Identity Center as an ISO-8601 string such as `PT8H` (a bare
   * number is milliseconds).
   */
  sessionDuration?: Duration.Input;
  /**
   * Optional relay state passed to supported applications.
   */
  relayState?: string;
}

export interface PermissionSet extends Resource<
  "AWS.IdentityCenter.PermissionSet",
  PermissionSetProps,
  {
    /** The Identity Center instance the permission set lives in. */
    instanceArn: string;
    /** The ARN of the permission set. */
    permissionSetArn: string;
    /** The name of the permission set. */
    name: string;
    /** The description of the permission set. */
    description: string | undefined;
    /** The session duration in ISO-8601 format (e.g. `PT8H`). */
    sessionDuration: string | undefined;
    /** The relay state URL users land on after federating, if set. */
    relayState: string | undefined;
    /** When the permission set was created. */
    createdDate: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * An IAM Identity Center permission set.
 * @resource
 * @section Creating Permission Sets
 * @example Administrator Access
 * ```typescript
 * const admin = yield* PermissionSet("AdministratorAccess", {
 *   name: "AdministratorAccess",
 *   description: "Administrator access for platform engineers",
 *   sessionDuration: "8 hours",
 * });
 * ```
 */
export const PermissionSet = Resource<PermissionSet>(
  "AWS.IdentityCenter.PermissionSet",
);

export const PermissionSetProvider = () =>
  Provider.effect(
    PermissionSet,
    Effect.gen(function* () {
      return {
        stables: ["permissionSetArn", "instanceArn"],
        list: () =>
          Effect.gen(function* () {
            // Permission sets live on an Identity Center instance. Resolve
            // the single enabled SSO instance, enumerate every permission
            // set ARN via `listPermissionSets` (exhaustively paginated by
            // the distilled `.items` stream), then hydrate each into the
            // exact `read` shape via `describePermissionSet` (bounded
            // concurrency, typed per-item not-found handled inside
            // `readPermissionSetByArn`).
            const instance = yield* resolveInstance();
            const arns = yield* ssoAdmin.listPermissionSets
              .items({
                InstanceArn: instance.InstanceArn!,
                MaxResults: 100,
              })
              .pipe(Stream.runCollect);
            const rows = yield* Effect.forEach(
              arns,
              (permissionSetArn) =>
                readPermissionSetByArn({
                  instanceArn: instance.InstanceArn!,
                  permissionSetArn,
                }),
              { concurrency: 10 },
            );
            return rows.filter(
              (row): row is PermissionSet["Attributes"] => row !== undefined,
            );
          }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.instanceArn !== news.instanceArn ||
            olds?.name !== news.name
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.permissionSetArn && output.instanceArn) {
            return yield* readPermissionSetByArn({
              instanceArn: output.instanceArn,
              permissionSetArn: output.permissionSetArn,
            });
          }

          if (!olds) {
            return undefined;
          }

          return yield* readPermissionSetByName(olds);
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const instance = yield* resolveInstance(
            output?.instanceArn ?? news.instanceArn,
          );
          const desiredSessionDuration =
            news.sessionDuration !== undefined
              ? toIsoSessionDuration(news.sessionDuration)
              : undefined;

          // Observe — find the permission set by ARN (when we already
          // have one) or by name on the resolved instance.
          let existing =
            (output?.permissionSetArn
              ? yield* readPermissionSetByArn({
                  instanceArn: instance.InstanceArn!,
                  permissionSetArn: output.permissionSetArn,
                })
              : undefined) ??
            (yield* readPermissionSetByName({
              ...news,
              instanceArn: instance.InstanceArn,
            }));

          // Ensure — create the permission set if missing.
          if (!existing) {
            const response = yield* retryIdentityCenter(
              ssoAdmin.createPermissionSet({
                InstanceArn: instance.InstanceArn!,
                Name: news.name,
                Description: news.description,
                SessionDuration: desiredSessionDuration,
                RelayState: news.relayState,
              }),
            );

            const createdArn = response.PermissionSet?.PermissionSetArn;
            existing =
              (createdArn
                ? yield* readPermissionSetByArn({
                    instanceArn: instance.InstanceArn!,
                    permissionSetArn: createdArn,
                  })
                : undefined) ??
              (yield* readPermissionSetByName({
                ...news,
                instanceArn: instance.InstanceArn,
              }));

            if (!existing) {
              return yield* Effect.fail(
                new Error(
                  `permission set '${news.name}' not found after create`,
                ),
              );
            }

            yield* session.note(existing.permissionSetArn);
            return existing;
          }

          // Sync mutable attributes — `updatePermissionSet` overwrites
          // description, sessionDuration, relayState. Diff against
          // observed cloud state so adoption converges; only call when
          // there's a real delta.
          if (
            (existing.description ?? undefined) !== news.description ||
            (existing.sessionDuration ?? undefined) !==
              desiredSessionDuration ||
            (existing.relayState ?? undefined) !== news.relayState
          ) {
            yield* retryIdentityCenter(
              ssoAdmin.updatePermissionSet({
                InstanceArn: existing.instanceArn,
                PermissionSetArn: existing.permissionSetArn,
                Description: news.description,
                SessionDuration: desiredSessionDuration,
                RelayState: news.relayState,
              }),
            );

            const updated = yield* readPermissionSetByArn({
              instanceArn: existing.instanceArn,
              permissionSetArn: existing.permissionSetArn,
            });
            if (!updated) {
              return yield* Effect.fail(
                new Error(
                  `permission set '${existing.permissionSetArn}' not found after update`,
                ),
              );
            }
            yield* session.note(updated.permissionSetArn);
            return updated;
          }

          yield* session.note(existing.permissionSetArn);
          return existing;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryIdentityCenter(
            ssoAdmin
              .deletePermissionSet({
                InstanceArn: output.instanceArn,
                PermissionSetArn: output.permissionSetArn,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

/**
 * Format a {@link Duration.Input} as the canonical ISO-8601 duration string
 * (`PT8H`, `PT1H30M`, …) the `SessionDuration` wire field expects. ISO-8601
 * is semantically part of the AWS field, so only the normalization (state
 * round-trip re-hydration) comes from the central Duration util.
 */
const toIsoSessionDuration = (input: Duration.Input): string => {
  const totalSeconds = Math.round(
    Duration.toSeconds(normalizeDurationInput(input)),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    hours > 0 ? `${hours}H` : "",
    minutes > 0 ? `${minutes}M` : "",
    seconds > 0 || totalSeconds === 0 ? `${seconds}S` : "",
  ].join("");
  return `PT${parts}`;
};

const readPermissionSetByArn = Effect.fn(function* ({
  instanceArn,
  permissionSetArn,
}: {
  instanceArn: string;
  permissionSetArn: string;
}) {
  const response = yield* retryIdentityCenter(
    ssoAdmin
      .describePermissionSet({
        InstanceArn: instanceArn,
        PermissionSetArn: permissionSetArn,
      })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

  const permissionSet = response?.PermissionSet;
  if (!permissionSet?.PermissionSetArn || !permissionSet.Name) {
    return undefined;
  }

  return {
    instanceArn,
    permissionSetArn: permissionSet.PermissionSetArn,
    name: permissionSet.Name,
    description: permissionSet.Description,
    sessionDuration: permissionSet.SessionDuration,
    relayState: permissionSet.RelayState,
    createdDate: permissionSet.CreatedDate,
  } satisfies PermissionSet["Attributes"];
});

const readPermissionSetByName = Effect.fn(function* ({
  instanceArn,
  name,
}: Pick<PermissionSetProps, "instanceArn" | "name">) {
  const instance = yield* resolveInstance(instanceArn);
  const arns = yield* ssoAdmin.listPermissionSets
    .items({
      InstanceArn: instance.InstanceArn!,
      MaxResults: 100,
    })
    .pipe(Stream.runCollect);

  for (const permissionSetArn of arns) {
    const permissionSet = yield* readPermissionSetByArn({
      instanceArn: instance.InstanceArn!,
      permissionSetArn,
    });
    if (permissionSet?.name === name) {
      return permissionSet;
    }
  }

  return undefined;
});
