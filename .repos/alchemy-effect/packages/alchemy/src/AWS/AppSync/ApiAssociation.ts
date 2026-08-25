import * as appsync from "@distilled.cloud/aws/appsync";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryConcurrentModification } from "./common.ts";
import type { AppSyncDomainName } from "./DomainName.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

export interface ApiAssociationProps {
  /**
   * The custom domain name to associate. Changing it triggers a
   * replacement.
   */
  domainName: string;
  /**
   * ID of the GraphQL API served at the domain. Changing it triggers a
   * replacement (a domain serves exactly one API).
   */
  apiId: string;
}

export interface AppSyncApiAssociation extends Resource<
  "AWS.AppSync.ApiAssociation",
  ApiAssociationProps,
  {
    /** The associated domain name. */
    domainName: string;
    /** The associated API. */
    apiId: string;
  },
  never,
  Providers
> {}

/**
 * Associates a GraphQL API with a custom {@link DomainName}
 * (existence-only resource — a domain serves exactly one API).
 * @resource
 * @section Associating an API
 * @example Serve an API at a custom domain
 * ```typescript
 * yield* AppSync.ApiAssociation("Assoc", { domain, api });
 * ```
 */
export const ApiAssociationResource = Resource<AppSyncApiAssociation>(
  "AWS.AppSync.ApiAssociation",
);

export interface ApiAssociationInputProps {
  /** The `DomainName` resource (preferred). Alternatively pass `domainName`. */
  domain?: AppSyncDomainName;
  domainName?: Input<string>;
  /** The `GraphqlApi` resource (preferred). Alternatively pass `apiId`. */
  api?: GraphqlApi;
  apiId?: Input<string>;
}

/**
 * User-facing wrapper for the ApiAssociation resource. Accepts the
 * `DomainName` and `GraphqlApi` resources directly.
 */
export const ApiAssociation = (id: string, props: ApiAssociationInputProps) =>
  Effect.gen(function* () {
    const domainName = props.domainName ?? props.domain?.domainName;
    const apiId = props.apiId ?? props.api?.apiId;
    if (!domainName || !apiId) {
      return yield* Effect.die(
        "ApiAssociation requires `domain`/`domainName` and `api`/`apiId`.",
      );
    }
    return yield* ApiAssociationResource(id, { domainName, apiId } as any);
  });

export const ApiAssociationProvider = () =>
  Provider.effect(
    ApiAssociationResource,
    Effect.gen(function* () {
      const getAssociationSafe = (domainName: string) =>
        appsync.getApiAssociation({ domainName }).pipe(
          Effect.map((response) => response.apiAssociation),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      /** Associations transition PROCESSING → SUCCESS/FAILED (~seconds). */
      const waitForSettled = (domainName: string) =>
        getAssociationSafe(domainName).pipe(
          Effect.repeat({
            schedule: Schedule.fixed("2 seconds"),
            until: (association) =>
              association === undefined ||
              association.associationStatus !== "PROCESSING",
            times: 30,
          }),
        );

      return ApiAssociationResource.Provider.of({
        stables: ["domainName", "apiId"],

        // Sub-resource keyed entirely by its custom domain (domainName) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const domainName = output?.domainName ?? olds?.domainName;
          if (domainName === undefined) return undefined;
          const association = yield* getAssociationSafe(domainName);
          if (association?.apiId == null) return undefined;
          return { domainName, apiId: association.apiId };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.domainName !== olds.domainName ||
            news.apiId !== olds.apiId
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // Existence-only: observe → associate when missing or pointing
          // at a different API (associateApi is an upsert per domain).
          const observed = yield* getAssociationSafe(news.domainName);
          if (observed?.apiId !== news.apiId) {
            yield* retryConcurrentModification(
              appsync.associateApi({
                domainName: news.domainName,
                apiId: news.apiId,
              }),
            );
            yield* waitForSettled(news.domainName);
            yield* session.note(
              `Associated ${news.apiId} with ${news.domainName}`,
            );
          }
          return { domainName: news.domainName, apiId: news.apiId };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrentModification(
            appsync
              .disassociateApi({ domainName: output.domainName })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          // Wait until the association is gone so a dependent DomainName
          // delete doesn't race the detach (bounded ~60s).
          yield* getAssociationSafe(output.domainName).pipe(
            Effect.repeat({
              schedule: Schedule.fixed("2 seconds"),
              until: (association) => association?.apiId == null,
              times: 30,
            }),
          );
        }),
      });
    }),
  );
