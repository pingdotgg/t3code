import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  listOrgNames,
  orgIdOf,
  orgNameOf,
  ownedBy,
  recordToAttributes,
  sameRecord,
  sameStringList,
  userAttributes,
} from "./operations.ts";

export type DevelopersAppsKeyProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the key.
   */
  organization?: string;
  /**
   * Parent developer email or `organizations/{org}/developers/{email}`.
   * Immutable — changing it replaces the key.
   */
  developer: string;
  /**
   * Parent developer app name or full resource name. Immutable — changing
   * it replaces the key.
   */
  app: string;
  /**
   * Consumer key. If omitted, a unique key is generated. Immutable —
   * changing it replaces the key.
   */
  consumerKey?: string;
  /**
   * Consumer secret. Required on create when supplying a custom key; if
   * omitted, a unique secret is generated. Immutable — changing it
   * replaces the key.
   */
  consumerSecret?: string;
  /**
   * Scopes to apply to the key.
   */
  scopes?: string[];
  /**
   * API products associated with the key. Applied after create via
   * UpdateDeveloperAppKey.
   */
  apiProducts?: string[];
  /**
   * Credential status (`approved` or `revoked`).
   * @default "approved"
   */
  status?: string;
  /**
   * Expiration time in seconds. `-1` (default) never expires. Immutable
   * after create.
   */
  expiresInSeconds?: string;
  /**
   * Custom attributes. Alchemy ownership attributes are merged in
   * automatically.
   */
  attributes?: Record<string, string>;
};

export type DevelopersAppsKey = Resource<
  "GCP.Apigee.DevelopersAppsKey",
  DevelopersAppsKeyProps,
  {
    /** Full resource name `organizations/{org}/developers/{email}/apps/{app}/keys/{key}`. */
    name: string;
    /** Consumer key. */
    consumerKey: string;
    /** Consumer secret. */
    consumerSecret: string | undefined;
    /** Parent developer email. */
    developer: string;
    /** Parent app name. */
    app: string;
    /** Apigee organization id. */
    organization: string;
    /** Scopes. */
    scopes: string[];
    /** Associated API products. */
    apiProducts: unknown[];
    /** Credential status. */
    status: string | undefined;
    /** User attributes (Alchemy ownership attributes stripped). */
    attributes: Record<string, string>;
    /** Issued-at time in milliseconds since epoch. */
    issuedAt: string | undefined;
    /** Expiration time in milliseconds since epoch. */
    expiresAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * A custom consumer key and secret for an Apigee developer app.
 *
 * Apigee keys have no labels field, so Alchemy stamps ownership into
 * custom attributes for `list` / nuke. The consumer key is identity —
 * changing it replaces the key. Scopes, API products, status, and
 * attributes update in place.
 *
 * ### Creating a Developer App Key
 * **Example:** Generated key under a developer app
 * ```typescript
 * const key = yield* GCP.Apigee.DevelopersAppsKey("PortalKey", {
 *   developer: developer.email,
 *   app: app.appName,
 * });
 * ```
 *
 * **Example:** Custom key and secret
 * ```typescript
 * const key = yield* GCP.Apigee.DevelopersAppsKey("PortalKey", {
 *   developer: "ada@example.com",
 *   app: "portal-app",
 *   consumerKey: "portal-key",
 *   consumerSecret: "portal-secret",
 *   status: "approved",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const DevelopersAppsKey = Resource<DevelopersAppsKey>(
  "GCP.Apigee.DevelopersAppsKey",
);

export class DevelopersAppsKeyNotResolved extends Data.TaggedError(
  "GCP.Apigee.DevelopersAppsKeyNotResolved",
)<{
  name: string;
}> {}

const developerEmailOf = (developer: string) =>
  developer.includes("/developers/") ? lastSegment(developer) : developer;

const appNameOf = (app: string) =>
  app.includes("/apps/") ? lastSegment(app) : app;

const appParentOf = (organization: string, developer: string, app: string) =>
  `${childName(orgNameOf(organization), "developers", developerEmailOf(developer))}/apps/${appNameOf(app)}`;

const resourceName = (
  organization: string,
  developer: string,
  app: string,
  consumerKey: string,
) => `${appParentOf(organization, developer, app)}/keys/${consumerKey}`;

const toKeyId = (id: string, explicit: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({ id, maxLength: 64, lowercase: true });
  });

const toSecret = (id: string, explicit: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    return yield* createPhysicalName({
      id: `${id}-secret`,
      maxLength: 64,
      lowercase: true,
    });
  });

const productsOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const toAttrs = (
  key: apigee.GoogleCloudApigeeV1DeveloperAppKey,
  organization: string,
  developer: string,
  app: string,
) => {
  const consumerKey = key.consumerKey ?? "";
  return {
    name: resourceName(organization, developer, app, consumerKey),
    consumerKey,
    consumerSecret: key.consumerSecret,
    developer: developerEmailOf(developer),
    app: appNameOf(app),
    organization: orgIdOf(organization),
    scopes: key.scopes ?? [],
    apiProducts: productsOf(key.apiProducts),
    status: key.status,
    attributes: userAttributes(attributesToRecord(key.attributes)),
    issuedAt: key.issuedAt,
    expiresAt: key.expiresAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsDevelopersAppsKeys({ name })
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

export const DevelopersAppsKeyProvider = () =>
  Provider.succeed(DevelopersAppsKey, {
    stables: [
      "name",
      "consumerKey",
      "developer",
      "app",
      "organization",
      "issuedAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousKey = olds?.consumerKey ?? output?.consumerKey;
      const previousSecret = olds?.consumerSecret ?? output?.consumerSecret;
      const previousDeveloper = olds?.developer ?? output?.developer;
      const previousApp = olds?.app ?? output?.app;
      const previousOrg = olds?.organization ?? output?.organization;
      const keyChanged =
        previousKey !== undefined &&
        news.consumerKey !== undefined &&
        news.consumerKey !== previousKey;
      const secretChanged =
        previousSecret !== undefined &&
        news.consumerSecret !== undefined &&
        news.consumerSecret !== previousSecret;
      const developerChanged =
        previousDeveloper !== undefined &&
        developerEmailOf(news.developer) !==
          developerEmailOf(previousDeveloper);
      const appChanged =
        previousApp !== undefined &&
        appNameOf(news.app) !== appNameOf(previousApp);
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      if (
        keyChanged ||
        secretChanged ||
        developerChanged ||
        appChanged ||
        orgChanged
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            keyChanged && !developerChanged && !appChanged && !orgChanged,
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
      const app = olds?.app ?? output?.app;
      if (developer === undefined || app === undefined) return undefined;
      const consumerKey = yield* toKeyId(
        id,
        olds?.consumerKey,
        output?.consumerKey,
      );
      const name =
        output?.name ?? resourceName(organization, developer, app, consumerKey);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, developer, app);
      return (yield* ownedBy(id, attributesToRecord(existing.attributes)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: DevelopersAppsKey["Attributes"][] = [];
        for (const organization of orgs) {
          const emails = yield* listDeveloperEmails(organization);
          for (const email of emails) {
            const page = yield* apigee
              .listOrganizationsDevelopersApps({
                parent: childName(organization, "developers", email),
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
              for (const credential of app.credentials ?? []) {
                const labels = attributesToRecord(credential.attributes);
                if (
                  !Object.keys(labels).some((key) => key.startsWith("alchemy-"))
                ) {
                  continue;
                }
                rows.push(
                  toAttrs(
                    {
                      consumerKey: credential.consumerKey,
                      consumerSecret: credential.consumerSecret,
                      scopes: credential.scopes,
                      apiProducts: credential.apiProducts,
                      status: credential.status,
                      attributes: credential.attributes,
                      issuedAt: credential.issuedAt,
                      expiresAt: credential.expiresAt,
                    },
                    organization,
                    email,
                    app.name ?? "",
                  ),
                );
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
      const app = appNameOf(news.app);
      const consumerKey = yield* toKeyId(
        id,
        news.consumerKey,
        output?.consumerKey,
      );
      const consumerSecret = yield* toSecret(
        id,
        news.consumerSecret ?? output?.consumerSecret,
      );
      const parent = appParentOf(organization, developer, app);
      const name = `${parent}/keys/${consumerKey}`;
      const ownership = yield* createOwnership(id);
      const attributes = desiredAttributes(news.attributes, ownership);
      const status = news.status ?? "approved";

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsDevelopersAppsKeys({
            parent,
            body: {
              consumerKey,
              consumerSecret,
              expiresInSeconds: news.expiresInSeconds,
              attributes: recordToAttributes(attributes),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DevelopersAppsKeyNotResolved({ name });
      }

      const observedAttributes = attributesToRecord(current.attributes);
      const scopesChanged = !sameStringList(current.scopes, news.scopes);
      const productsChanged = !sameStringList(
        productsOf(current.apiProducts).map(String),
        (news.apiProducts ?? []).map(String),
      );
      const statusChanged = (current.status ?? "") !== status;
      const attributesChanged = !sameRecord(observedAttributes, attributes);

      if (
        scopesChanged ||
        productsChanged ||
        statusChanged ||
        attributesChanged
      ) {
        current =
          yield* apigee.updateDeveloperAppKeyOrganizationsDevelopersAppsKeys({
            name,
            action: statusChanged ? status : undefined,
            body: {
              consumerKey,
              scopes: news.scopes,
              apiProducts: news.apiProducts,
              attributes: recordToAttributes(attributes),
            },
          });
      }

      return toAttrs(current, organization, developer, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsDevelopersAppsKeys({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
