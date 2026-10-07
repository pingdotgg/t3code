import * as iap from "@distilled.cloud/gcp/iap_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  brandNameOf,
  encodeOwnershipLine,
  findOwnedClient,
  getClient,
  listOwnedClients,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseClientName,
  parseOwnership,
  replaceOnIdentity,
  sameText,
  toGeneratedDisplayName,
  waitUntilGone,
} from "./internal.ts";

export type BrandsIdentityAwareProxyClientProps = {
  /**
   * Parent IAP OAuth brand. Full name
   * `projects/{project}/brands/{brand}` or the brand id. Immutable —
   * changing it replaces the client. The project must belong to a
   * Google Workspace organization, and the brand must already exist.
   */
  brand: string;
  /**
   * Human-friendly OAuth client name. IAP clients have no labels field,
   * so Alchemy stamps ownership into a `[alchemy …]` prefix and strips
   * it from attributes. Immutable — the API has no update, so changing
   * this replaces the client.
   */
  displayName?: string;
  /**
   * Server-assigned OAuth client id (the `{client_id}` segment of
   * `projects/{project}/brands/{brand}/identityAwareProxyClients/{client_id}`).
   * Leave blank on create. Immutable — changing it replaces the client.
   */
  identityAwareProxyClientId?: string;
};

export type BrandsIdentityAwareProxyClient = Resource<
  "GCP.IAP.BrandsIdentityAwareProxyClient",
  BrandsIdentityAwareProxyClientProps,
  {
    /** Full resource name `projects/{project}/brands/{brand}/identityAwareProxyClients/{client_id}`. */
    name: string;
    /** Server-assigned OAuth client id. */
    identityAwareProxyClientId: string;
    /** Parent brand resource name. */
    brand: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /**
     * OAuth client secret. Returned on create; later reads reuse the
     * previously persisted value when the API omits it.
     */
    secret: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Identity-Aware Proxy owned OAuth client.
 *
 * IAP OAuth clients have no labels field, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. Brand, client id, and display
 * name are identity — the API has no patch, so changing any of them
 * replaces the client. Creating a client requires an existing
 * internal-only OAuth brand on a Workspace project.
 *
 * ### Creating an IAP OAuth Client
 * **Example:** Named client under an existing brand
 * ```typescript
 * const client = yield* GCP.IAP.BrandsIdentityAwareProxyClient("Console", {
 *   brand: "projects/my-project/brands/123456",
 *   displayName: "Alchemy console",
 * });
 * ```
 *
 * **Example:** Generated display name
 * ```typescript
 * const client = yield* GCP.IAP.BrandsIdentityAwareProxyClient("Console", {
 *   brand: existingBrandName,
 * });
 * ```
 *
 * @resource
 * @category IAP
 */
export const BrandsIdentityAwareProxyClient =
  Resource<BrandsIdentityAwareProxyClient>(
    "GCP.IAP.BrandsIdentityAwareProxyClient",
  );

export class BrandsIdentityAwareProxyClientNotResolved extends Data.TaggedError(
  "GCP.IAP.BrandsIdentityAwareProxyClientNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  client: iap.IdentityAwareProxyClient,
  project: string,
  previousSecret?: string,
) => {
  const name = client.name ?? "";
  const parsed = parseClientName(name, project);
  return {
    name,
    identityAwareProxyClientId: parsed.identityAwareProxyClientId,
    brand: parsed.brand,
    project,
    displayName: parseOwnership(client.displayName).text,
    secret: client.secret ?? previousSecret,
  };
};

export const BrandsIdentityAwareProxyClientProvider = () =>
  Provider.succeed(BrandsIdentityAwareProxyClient, {
    stables: [
      "name",
      "identityAwareProxyClientId",
      "brand",
      "project",
      "secret",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId:
          olds?.identityAwareProxyClientId ??
          output?.identityAwareProxyClientId,
        nextId: news.identityAwareProxyClientId,
        previousParent: olds?.brand ?? output?.brand,
        nextParent: news.brand,
        extra:
          news.displayName !== undefined &&
          output?.displayName !== undefined &&
          !sameText(news.displayName, output.displayName),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const brand = brandNameOf(
        env.project,
        olds?.brand ?? output?.brand ?? "",
      );
      let existing = yield* getClient(output?.name ?? "");
      if (existing === undefined) {
        existing = yield* findOwnedClient(
          env.project,
          id,
          brand,
          olds?.displayName ?? output?.displayName,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, output?.secret);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clients = yield* listOwnedClients(env.project);
        return clients.map((client) => toAttrs(client, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const brand = brandNameOf(env.project, news.brand);
      const ownership = yield* ownershipLabels(id);
      const userDisplayName = yield* toGeneratedDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        userDisplayName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const name =
        output?.name ??
        (news.identityAwareProxyClientId
          ? `${brand}/identityAwareProxyClients/${news.identityAwareProxyClientId}`
          : "");

      let current = yield* getClient(name);
      if (current === undefined) {
        current = yield* findOwnedClient(
          env.project,
          id,
          brand,
          userDisplayName,
        );
      }

      if (current === undefined) {
        const created = yield* iap
          .createProjectsBrandsIdentityAwareProxyClients({
            parent: brand,
            body: { displayName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedClient(env.project, id, brand, userDisplayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BrandsIdentityAwareProxyClientNotResolved({
          name: name || `${brand}/identityAwareProxyClients`,
        });
      }

      return toAttrs(current, env.project, output?.secret);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* iap
        .deleteProjectsBrandsIdentityAwareProxyClients({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getClient(output.name));
    }),
  });
