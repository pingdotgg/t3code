import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  attributesToRecord,
  childName,
  createOwnership,
  defaultOrgName,
  desiredAttributes,
  lastSegment,
  letterPrefixedId,
  listOrgNames,
  orgIdOf,
  orgNameOf,
  ownedBy,
  recordToAttributes,
  sameRecord,
  sameStringList,
  userAttributes,
} from "./operations.ts";

export type DevelopersAppProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the app.
   */
  organization?: string;
  /**
   * Parent developer email or `organizations/{org}/developers/{email}`.
   * Immutable — changing it replaces the app.
   */
  developer: string;
  /**
   * App name (the `{app}` segment of
   * `organizations/{org}/developers/{email}/apps/{app}`). If omitted, a
   * unique name is generated. Immutable — changing it replaces the app.
   */
  appName?: string;
  /**
   * OAuth 2.0 callback URL.
   */
  callbackUrl?: string;
  /**
   * API products associated with the app.
   */
  apiProducts?: string[];
  /**
   * Scopes to apply to the app. Must already exist on associated API
   * products.
   */
  scopes?: string[];
  /**
   * Credential status (`approved` or `revoked`).
   */
  status?: string;
  /**
   * Expiration time in milliseconds for the auto-generated consumer key.
   * `-1` (default) never expires. Immutable after create.
   */
  keyExpiresIn?: string;
  /**
   * Developer app family.
   */
  appFamily?: string;
  /**
   * Custom attributes. Alchemy ownership attributes are merged in
   * automatically.
   */
  attributes?: Record<string, string>;
};

export type DevelopersApp = Resource<
  "GCP.Apigee.DevelopersApp",
  DevelopersAppProps,
  {
    /** Full resource name `organizations/{org}/developers/{email}/apps/{app}`. */
    name: string;
    /** App name (last path segment). */
    appName: string;
    /** Server-generated UUID. */
    appId: string | undefined;
    /** Parent developer email. */
    developer: string;
    /** Parent developer id. */
    developerId: string | undefined;
    /** Apigee organization id. */
    organization: string;
    /** OAuth callback URL. */
    callbackUrl: string | undefined;
    /** Associated API products. */
    apiProducts: string[];
    /** Scopes. */
    scopes: string[];
    /** Credential status. */
    status: string | undefined;
    /** Key expiration in milliseconds. */
    keyExpiresIn: string | undefined;
    /** Developer app family. */
    appFamily: string | undefined;
    /** User attributes (Alchemy ownership attributes stripped). */
    attributes: Record<string, string>;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee app owned by a developer, used to obtain API keys.
 *
 * Apigee developer apps have no labels field, so Alchemy stamps ownership
 * into custom attributes for `list` / nuke. Name and parent developer are
 * identity — changing `appName` or `developer` replaces the app. Callback
 * URL, products, scopes, status, and attributes update in place.
 *
 * ### Creating a Developer App
 * **Example:** App under an existing developer
 * ```typescript
 * const app = yield* GCP.Apigee.DevelopersApp("Portal", {
 *   developer: developer.email,
 *   callbackUrl: "https://example.com/callback",
 * });
 * ```
 *
 * **Example:** Named app with attributes
 * ```typescript
 * const app = yield* GCP.Apigee.DevelopersApp("Portal", {
 *   developer: "ada@example.com",
 *   appName: "portal-app",
 *   attributes: { team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const DevelopersApp = Resource<DevelopersApp>(
  "GCP.Apigee.DevelopersApp",
);

export class DevelopersAppNotResolved extends Data.TaggedError(
  "GCP.Apigee.DevelopersAppNotResolved",
)<{
  name: string;
}> {}

const developerEmailOf = (developer: string) => {
  if (developer.includes("/developers/")) {
    return lastSegment(developer);
  }
  return developer;
};

const developerNameOf = (organization: string, developer: string) =>
  childName(orgNameOf(organization), "developers", developerEmailOf(developer));

const resourceName = (
  organization: string,
  developer: string,
  appName: string,
) => `${developerNameOf(organization, developer)}/apps/${appName}`;

const toAttrs = (
  app: apigee.GoogleCloudApigeeV1DeveloperApp,
  organization: string,
  developer: string,
) => {
  const appName = app.name ?? "";
  const email = developerEmailOf(developer);
  return {
    name: resourceName(organization, email, appName),
    appName,
    appId: app.appId,
    developer: email,
    developerId: app.developerId,
    organization: orgIdOf(organization),
    callbackUrl: app.callbackUrl,
    apiProducts: app.apiProducts ?? [],
    scopes: app.scopes ?? [],
    status: app.status,
    keyExpiresIn: app.keyExpiresIn,
    appFamily: app.appFamily,
    attributes: userAttributes(attributesToRecord(app.attributes)),
    createdAt: app.createdAt,
    lastModifiedAt: app.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsDevelopersApps({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const listDeveloperEmails = (organization: string) =>
  apigee
    .listOrganizationsDevelopers({
      parent: organization,
      expand: true,
      count: "1000",
    })
    .pipe(
      Effect.map((page) =>
        (page.developer ?? [])
          .map((developer) => developer.email ?? "")
          .filter((email) => email.length > 0),
      ),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([] as string[]),
      ),
    );

export const DevelopersAppProvider = () =>
  Provider.succeed(DevelopersApp, {
    stables: [
      "name",
      "appName",
      "appId",
      "developer",
      "organization",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.appName ?? output?.appName;
      const previousDeveloper = olds?.developer ?? output?.developer;
      const previousOrg = olds?.organization ?? output?.organization;
      const nameChanged =
        previousName !== undefined &&
        news.appName !== undefined &&
        news.appName !== previousName;
      const developerChanged =
        previousDeveloper !== undefined &&
        developerEmailOf(news.developer) !==
          developerEmailOf(previousDeveloper);
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      if (nameChanged || developerChanged || orgChanged) {
        return {
          action: "replace" as const,
          deleteFirst: nameChanged && !developerChanged && !orgChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const developer = olds?.developer ?? output?.developer;
      if (developer === undefined) return undefined;
      const appName = yield* letterPrefixedId(
        id,
        olds?.appName,
        output?.appName,
        255,
      );
      const name =
        output?.name ?? resourceName(organization, developer, appName);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, developer);
      return (yield* ownedBy(id, attributesToRecord(existing.attributes)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: DevelopersApp["Attributes"][] = [];
        for (const organization of orgs) {
          const emails = yield* listDeveloperEmails(organization);
          for (const email of emails) {
            const page = yield* apigee
              .listOrganizationsDevelopersApps({
                parent: developerNameOf(organization, email),
                expand: true,
                count: "1000",
              })
              .pipe(
                Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                  Effect.succeed({
                    app: [] as apigee.GoogleCloudApigeeV1DeveloperApp[],
                  }),
                ),
              );
            for (const app of page.app ?? []) {
              const labels = attributesToRecord(app.attributes);
              if (
                Object.keys(labels).some((key) => key.startsWith("alchemy-"))
              ) {
                rows.push(toAttrs(app, organization, email));
              }
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const developer = developerEmailOf(news.developer);
      const appName = yield* letterPrefixedId(
        id,
        news.appName,
        output?.appName,
        255,
      );
      const parent = developerNameOf(organization, developer);
      const name = `${parent}/apps/${appName}`;
      const ownership = yield* createOwnership(id);
      const attributes = desiredAttributes(news.attributes, ownership);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsDevelopersApps({
            parent,
            body: {
              name: appName,
              callbackUrl: news.callbackUrl,
              apiProducts: news.apiProducts,
              scopes: news.scopes,
              status: news.status,
              keyExpiresIn: news.keyExpiresIn,
              appFamily: news.appFamily,
              attributes: recordToAttributes(attributes),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DevelopersAppNotResolved({ name });
      }

      const observedAttributes = attributesToRecord(current.attributes);
      const callbackChanged =
        (current.callbackUrl ?? "") !== (news.callbackUrl ?? "");
      const productsChanged = !sameStringList(
        current.apiProducts,
        news.apiProducts,
      );
      const scopesChanged = !sameStringList(current.scopes, news.scopes);
      const statusChanged =
        news.status !== undefined && (current.status ?? "") !== news.status;
      const familyChanged =
        (current.appFamily ?? "") !== (news.appFamily ?? "");
      const attributesChanged = !sameRecord(observedAttributes, attributes);

      if (
        callbackChanged ||
        productsChanged ||
        scopesChanged ||
        statusChanged ||
        familyChanged ||
        attributesChanged
      ) {
        current = yield* apigee.updateOrganizationsDevelopersApps({
          name,
          body: {
            name: appName,
            callbackUrl: news.callbackUrl,
            apiProducts: news.apiProducts,
            scopes: news.scopes,
            status: news.status ?? current.status,
            appFamily: news.appFamily,
            attributes: recordToAttributes(attributes),
          },
        });
      }

      return toAttrs(current, organization, developer);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsDevelopersApps({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
