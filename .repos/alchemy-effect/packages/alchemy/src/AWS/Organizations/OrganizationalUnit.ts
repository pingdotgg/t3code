import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  createName,
  readResourceTags,
  retryOrganizations,
  updateResourceTags,
} from "./common.ts";

export type OrganizationalUnitId = string;
export type OrganizationalUnitArn = string;

export interface OrganizationalUnitProps {
  /**
   * Parent root or OU ID.
   */
  parentId: string;
  /**
   * OU name. If omitted, Alchemy generates one.
   */
  name?: string;
  /**
   * Optional tags applied to the OU.
   */
  tags?: Record<string, string>;
}

export interface OrganizationalUnit extends Resource<
  "AWS.Organizations.OrganizationalUnit",
  OrganizationalUnitProps,
  {
    ouId: OrganizationalUnitId;
    ouArn: OrganizationalUnitArn;
    name: string;
    parentId: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Organizations organizational unit.
 *
 * @section Creating OUs
 * @example Nested OU
 * ```typescript
 * const workloads = yield* OrganizationalUnit("Workloads", {
 *   parentId: root.rootId,
 *   name: "workloads",
 * });
 * ```
 */
export const OrganizationalUnit = Resource<OrganizationalUnit>(
  "AWS.Organizations.OrganizationalUnit",
);

export const OrganizationalUnitProvider = () =>
  Provider.effect(
    OrganizationalUnit,
    Effect.gen(function* () {
      return {
        stables: ["ouId", "ouArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});

          if (olds?.parentId !== news?.parentId) {
            return { action: "replace" } as const;
          }

          if (oldName !== newName) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const state = output?.ouId
            ? yield* readOUById(output.ouId)
            : olds?.parentId
              ? yield* readOUByParentAndName({
                  parentId: olds.parentId,
                  name: yield* toName(id, olds ?? {}),
                })
              : undefined;
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);

          // Observe — locate the OU by ID if known, else by parent+name.
          // We fetch fresh so the reconciler converges over drift, adoption,
          // and partial prior runs. `output.ouId` is treated only as a
          // cache.
          let state = output?.ouId
            ? yield* readOUById(output.ouId)
            : yield* readOUByParentAndName({
                parentId: news.parentId,
                name,
              });

          // Ensure — create the OU if missing. Tolerate
          // `DuplicateOrganizationalUnitException` as adoption when a peer
          // reconciler created it concurrently.
          if (!state) {
            yield* retryOrganizations(
              organizations
                .createOrganizationalUnit({
                  ParentId: news.parentId,
                  Name: name,
                })
                .pipe(
                  Effect.catchTag(
                    "DuplicateOrganizationalUnitException",
                    () => Effect.void,
                  ),
                ),
            );
            state = yield* readOUByParentAndName({
              parentId: news.parentId,
              name,
            });
            if (!state) {
              return yield* Effect.fail(
                new Error(
                  `organizational unit '${name}' not found after create`,
                ),
              );
            }
          }

          // Sync name — observed ↔ desired. `parentId` is replacement-only,
          // so the diff has handled any cross-parent move.
          if (state.name !== name) {
            yield* retryOrganizations(
              organizations.updateOrganizationalUnit({
                OrganizationalUnitId: state.ouId,
                Name: name,
              }),
            );
          }

          // Sync tags — diff observed cloud tags against desired so
          // adoption and drift converge correctly without trusting `olds`.
          const tags = yield* updateResourceTags({
            id,
            resourceId: state.ouId,
            olds: state.tags,
            news: news.tags,
          });

          const updated = yield* readOUById(state.ouId);
          if (!updated) {
            return yield* Effect.fail(
              new Error(
                `organizational unit '${state.ouId}' not found after reconcile`,
              ),
            );
          }

          yield* session.note(updated.ouArn);
          return {
            ...updated,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .deleteOrganizationalUnit({
                OrganizationalUnitId: output.ouId,
              })
              .pipe(
                Effect.catchTag(
                  "OrganizationalUnitNotFoundException",
                  () => Effect.void,
                ),
              ),
          );
        }),
      };
    }),
  );

const toName = (id: string, props: { name?: string } = {}) =>
  createName(id, props.name, 128);

const listOUsForParent = (parentId: string) =>
  collectPages(
    (NextToken) =>
      organizations.listOrganizationalUnitsForParent({
        ParentId: parentId,
        NextToken,
      }),
    (page) => page.OrganizationalUnits,
  ).pipe(retryOrganizations);

const readParentId = (childId: string) =>
  collectPages(
    (NextToken) => organizations.listParents({ ChildId: childId, NextToken }),
    (page) => page.Parents,
  ).pipe(
    retryOrganizations,
    Effect.map((parents) => parents[0]?.Id),
  );

const readOUById = Effect.fn(function* (ouId: string) {
  const described = yield* retryOrganizations(
    organizations
      .describeOrganizationalUnit({
        OrganizationalUnitId: ouId,
      })
      .pipe(
        Effect.map((response) => response.OrganizationalUnit),
        Effect.catchTag("OrganizationalUnitNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

  if (!described?.Id || !described.Arn || !described.Name) {
    return undefined;
  }

  const [parentId, tags] = yield* Effect.all([
    readParentId(described.Id).pipe(
      Effect.catchTag("ChildNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
    readResourceTags(described.Id).pipe(
      Effect.catchTag("TargetNotFoundException", () => Effect.succeed({})),
    ),
  ]);

  return {
    ouId: described.Id,
    ouArn: described.Arn,
    name: described.Name,
    parentId,
    tags,
  } satisfies OrganizationalUnit["Attributes"];
});

const readOUByParentAndName = Effect.fn(function* ({
  parentId,
  name,
}: {
  parentId: string;
  name: string;
}) {
  const match = (yield* listOUsForParent(parentId)).find(
    (ou) => ou.Name === name,
  );
  return match?.Id ? yield* readOUById(match.Id) : undefined;
});
