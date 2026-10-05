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
  userAttributes,
} from "./operations.ts";

export type DeveloperProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the developer.
   */
  organization?: string;
  /**
   * Developer email (unique within the organization, lowercase). If omitted,
   * a unique `{physical}@alchemy.example` address is generated. Immutable —
   * changing it replaces the developer.
   */
  email?: string;
  /**
   * First name.
   * @default "Alchemy"
   */
  firstName?: string;
  /**
   * Last name.
   * @default "Developer"
   */
  lastName?: string;
  /**
   * User name. If omitted, the local-part of `email` is used.
   */
  userName?: string;
  /**
   * Developer app family.
   */
  appFamily?: string;
  /**
   * Access type.
   */
  accessType?: string;
  /**
   * Custom attributes (name/value pairs, max 18). Alchemy ownership
   * attributes (`alchemy-stack`, `alchemy-stage`, `alchemy-id`) are merged
   * in automatically.
   */
  attributes?: Record<string, string>;
};

export type Developer = Resource<
  "GCP.Apigee.Developer",
  DeveloperProps,
  {
    /** Full resource name `organizations/{org}/developers/{email}`. */
    name: string;
    /** Developer email. */
    email: string;
    /** Apigee organization id. */
    organization: string;
    /** Server-generated developer id. */
    developerId: string | undefined;
    /** First name. */
    firstName: string | undefined;
    /** Last name. */
    lastName: string | undefined;
    /** User name. */
    userName: string | undefined;
    /** Developer app family. */
    appFamily: string | undefined;
    /** Access type. */
    accessType: string | undefined;
    /** User attributes (Alchemy ownership attributes stripped). */
    attributes: Record<string, string>;
    /** Status (`active` or `inactive`). */
    status: string | undefined;
    /** Associated app names. */
    apps: string[];
    /** Associated company names. */
    companies: string[];
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee developer that can register apps and obtain API keys.
 *
 * Apigee developers have no labels field, so Alchemy stamps ownership into
 * custom attributes for `list` / nuke. Email is identity — changing `email`
 * replaces the developer. Name, attributes, and access type update in place.
 *
 * ### Creating a Developer
 * **Example:** Generated email
 * ```typescript
 * const developer = yield* GCP.Apigee.Developer("Owner", {
 *   firstName: "Ada",
 *   lastName: "Lovelace",
 * });
 * ```
 *
 * **Example:** Explicit email and attributes
 * ```typescript
 * const developer = yield* GCP.Apigee.Developer("Owner", {
 *   email: "ada@example.com",
 *   firstName: "Ada",
 *   lastName: "Lovelace",
 *   userName: "ada",
 *   attributes: { team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Developer = Resource<Developer>("GCP.Apigee.Developer");

export class DeveloperNotResolved extends Data.TaggedError(
  "GCP.Apigee.DeveloperNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, email: string) =>
  `${orgNameOf(organization)}/developers/${email}`;

const toEmail = (id: string, email: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (email !== undefined) return email.toLowerCase();
    if (existing !== undefined) return existing.toLowerCase();
    const generated = yield* createPhysicalName({
      id,
      maxLength: 48,
      lowercase: true,
    });
    return `${generated}@alchemy.example`;
  });

const toAttrs = (
  developer: apigee.GoogleCloudApigeeV1Developer,
  organization: string,
) => {
  const email = (developer.email ?? "").toLowerCase();
  return {
    name: resourceName(organization, email),
    email,
    organization: orgIdOf(organization),
    developerId: developer.developerId,
    firstName: developer.firstName,
    lastName: developer.lastName,
    userName: developer.userName,
    appFamily: developer.appFamily,
    accessType: developer.accessType,
    attributes: userAttributes(attributesToRecord(developer.attributes)),
    status: developer.status,
    apps: developer.apps ?? [],
    companies: developer.companies ?? [],
    createdAt: developer.createdAt,
    lastModifiedAt: developer.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsDevelopers({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const DeveloperProvider = () =>
  Provider.succeed(Developer, {
    stables: ["name", "email", "organization", "developerId", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEmail = olds?.email ?? output?.email;
      const previousOrg = olds?.organization ?? output?.organization;
      const emailChanged =
        previousEmail !== undefined &&
        news.email !== undefined &&
        news.email.toLowerCase() !== previousEmail.toLowerCase();
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      if (emailChanged || orgChanged) {
        return {
          action: "replace" as const,
          deleteFirst: emailChanged && !orgChanged,
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
      const email = yield* toEmail(id, olds?.email, output?.email);
      const name = output?.name ?? resourceName(organization, email);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      return (yield* ownedBy(id, attributesToRecord(existing.attributes)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: Developer["Attributes"][] = [];
        for (const organization of orgs) {
          const page = yield* apigee
            .listOrganizationsDevelopers({
              parent: organization,
              expand: true,
              count: "1000",
            })
            .pipe(
              Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                Effect.succeed({
                  developer: [] as apigee.GoogleCloudApigeeV1Developer[],
                }),
              ),
            );
          for (const developer of page.developer ?? []) {
            const labels = attributesToRecord(developer.attributes);
            if (Object.keys(labels).some((key) => key.startsWith("alchemy-"))) {
              rows.push(toAttrs(developer, organization));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const email = yield* toEmail(id, news.email, output?.email);
      const name = resourceName(organization, email);
      const firstName = news.firstName ?? "Alchemy";
      const lastName = news.lastName ?? "Developer";
      const userName =
        news.userName ?? lastSegment(email.split("@")[0] ?? email);
      const ownership = yield* createOwnership(id);
      const attributes = desiredAttributes(news.attributes, ownership);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsDevelopers({
            parent: organization,
            body: {
              email,
              firstName,
              lastName,
              userName,
              appFamily: news.appFamily,
              accessType: news.accessType,
              attributes: recordToAttributes(attributes),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DeveloperNotResolved({ name });
      }

      const observed = {
        firstName: current.firstName ?? "",
        lastName: current.lastName ?? "",
        userName: current.userName ?? "",
        appFamily: current.appFamily ?? "",
        accessType: current.accessType ?? "",
        attributes: attributesToRecord(current.attributes),
      };
      const desired = {
        firstName,
        lastName,
        userName,
        appFamily: news.appFamily ?? "",
        accessType: news.accessType ?? "",
        attributes,
      };
      const changed =
        observed.firstName !== desired.firstName ||
        observed.lastName !== desired.lastName ||
        observed.userName !== desired.userName ||
        observed.appFamily !== desired.appFamily ||
        observed.accessType !== desired.accessType ||
        !sameRecord(observed.attributes, desired.attributes);

      if (changed) {
        current = yield* apigee.updateOrganizationsDevelopers({
          name,
          body: {
            email,
            firstName,
            lastName,
            userName,
            appFamily: news.appFamily,
            accessType: news.accessType,
            attributes: recordToAttributes(attributes),
          },
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsDevelopers({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
