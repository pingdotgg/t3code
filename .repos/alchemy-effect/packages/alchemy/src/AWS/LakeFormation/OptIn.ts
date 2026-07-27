import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryWhileInvalidPrincipal } from "./internal.ts";
import {
  type LakeFormationResourceSpec,
  toWireResource,
} from "./ResourceSpec.ts";

export interface OptInProps {
  /**
   * The principal (IAM user/role ARN or `IAM_ALLOWED_PRINCIPALS`) whose
   * access to the resource is opted into Lake Formation enforcement.
   * Changing it replaces the opt-in.
   */
  principal: string;
  /**
   * The Data Catalog resource (database, table, …) to enforce Lake
   * Formation permissions on for the principal. Changing it replaces the
   * opt-in.
   */
  resource: LakeFormationResourceSpec;
}

export interface OptIn extends Resource<
  "AWS.LakeFormation.OptIn",
  OptInProps,
  {
    principal: string;
    resource: lf.Resource;
  },
  {},
  Providers
> {}

/**
 * A Lake Formation opt-in — enforces Lake Formation permissions for one
 * principal on one Data Catalog resource while the account is in hybrid
 * access mode (where IAM/S3 policies otherwise govern access).
 *
 * @resource
 * @section Opting Into Lake Formation Enforcement
 * @example Enforce Lake Formation for a Role on a Database
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const optIn = yield* AWS.LakeFormation.OptIn("AnalystOptIn", {
 *   principal: analystRole.roleArn,
 *   resource: { database: { name: database.databaseName } },
 * });
 * ```
 */
export const OptIn = Resource<OptIn>("AWS.LakeFormation.OptIn");

export const OptInProvider = () =>
  Provider.effect(
    OptIn,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        principal: string,
        resource: lf.Resource,
      ) {
        const pages = yield* lf.listLakeFormationOptIns
          .pages({
            Principal: { DataLakePrincipalIdentifier: principal },
            Resource: resource,
          })
          .pipe(
            Stream.runCollect,
            // a deleted resource (e.g. the Glue database is already gone)
            // means the opt-in no longer exists either; a deleted/not-yet-
            // propagated IAM principal likewise has no visible opt-ins
            Effect.catchTag(
              ["EntityNotFoundException", "InvalidLakeFormationPrincipal"],
              () => Effect.succeed([]),
            ),
          );
        return Array.from(pages)
          .flatMap((page) => page.LakeFormationOptInsInfoList ?? [])
          .find(
            (info) => info.Principal?.DataLakePrincipalIdentifier === principal,
          );
      });

      return OptIn.Provider.of({
        stables: ["principal", "resource"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* lf.listLakeFormationOptIns
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.LakeFormationOptInsInfoList ?? [])
              .filter(
                (info) =>
                  info.Principal?.DataLakePrincipalIdentifier !== undefined &&
                  info.Resource !== undefined,
              )
              .map((info) => ({
                principal: info.Principal!.DataLakePrincipalIdentifier!,
                resource: info.Resource!,
              }));
          }),

        read: Effect.fn(function* ({ olds, output }) {
          const principal = output?.principal ?? olds?.principal;
          const resource =
            output?.resource ??
            (olds !== undefined ? toWireResource(olds.resource) : undefined);
          if (principal === undefined || resource === undefined) {
            return undefined;
          }
          const found = yield* observe(principal, resource);
          if (found === undefined) return undefined;
          // Opt-ins are not taggable — ownership cannot be verified.
          return { principal, resource };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.principal !== olds.principal ||
            JSON.stringify(toWireResource(news.resource)) !==
              JSON.stringify(toWireResource(olds.resource))
          ) {
            // an opt-in has no mutable body — any change replaces it
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const resource = toWireResource(news.resource);

          // 1. OBSERVE
          const found = yield* observe(news.principal, resource);

          // 2. ENSURE — existence-only resource, nothing to sync. A freshly
          //    created IAM principal takes ~10s to propagate before Lake
          //    Formation accepts it, so retry through the typed rejection.
          if (found === undefined) {
            yield* lf
              .createLakeFormationOptIn({
                Principal: { DataLakePrincipalIdentifier: news.principal },
                Resource: resource,
              })
              .pipe(retryWhileInvalidPrincipal);
          }

          yield* session.note(news.principal);
          return { principal: news.principal, resource };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* lf
            .deleteLakeFormationOptIn({
              Principal: {
                DataLakePrincipalIdentifier: output.principal,
              },
              Resource: output.resource,
            })
            .pipe(
              // the opt-in (or its principal) is already gone
              Effect.catchTag(
                ["EntityNotFoundException", "InvalidLakeFormationPrincipal"],
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
