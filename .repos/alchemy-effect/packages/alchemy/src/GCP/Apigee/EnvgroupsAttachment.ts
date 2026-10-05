import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  childName,
  collectPages,
  defaultOrgName,
  hasOwnershipMarker,
  lastSegment,
  listOrgNames,
  orgIdOf,
  orgNameOf,
  stringField,
  waitForOperation,
} from "./operations.ts";

export type EnvgroupsAttachmentProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the
   * attachment.
   */
  organization?: string;
  /**
   * Parent environment group id or
   * `organizations/{org}/envgroups/{envgroup}`. Immutable — changing it
   * replaces the attachment.
   */
  envgroup: string;
  /**
   * Attached environment id (the `{env}` segment of
   * `organizations/{org}/environments/{env}`). Immutable — changing it
   * replaces the attachment.
   */
  environment: string;
};

export type EnvgroupsAttachment = Resource<
  "GCP.Apigee.EnvgroupsAttachment",
  EnvgroupsAttachmentProps,
  {
    /** Full resource name `organizations/{org}/envgroups/{envgroup}/attachments/{attachment}`. */
    name: string;
    /** Attachment id (last path segment). */
    attachmentId: string;
    /** Parent environment group id. */
    envgroup: string;
    /** Attached environment id. */
    environment: string;
    /** Apigee organization id. */
    organization: string;
    /** Server-reported environment group id. */
    environmentGroupId: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An attachment of an Apigee environment to an environment group.
 *
 * Existence-only: the identity is the (envgroup, environment) pair. The
 * API has no labels or description, so `list` / nuke returns attachments
 * whose attached environment carries an Alchemy description marker.
 *
 * ### Creating an Environment Group Attachment
 * **Example:** Attach an environment to a group
 * ```typescript
 * const attachment = yield* GCP.Apigee.EnvgroupsAttachment("ProdApi", {
 *   envgroup: group.envgroupId,
 *   environment: environment.environmentId,
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvgroupsAttachment = Resource<EnvgroupsAttachment>(
  "GCP.Apigee.EnvgroupsAttachment",
);

export class EnvgroupsAttachmentNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvgroupsAttachmentNotResolved",
)<{
  parent: string;
  environment: string;
}> {}

const envgroupIdOf = (envgroup: string) =>
  envgroup.includes("/envgroups/") ? lastSegment(envgroup) : envgroup;

const environmentIdOf = (environment: string) =>
  environment.includes("/environments/")
    ? lastSegment(environment)
    : environment;

const parentOf = (organization: string, envgroup: string) =>
  childName(orgNameOf(organization), "envgroups", envgroupIdOf(envgroup));

const toAttrs = (
  attachment: apigee.GoogleCloudApigeeV1EnvironmentGroupAttachment,
  organization: string,
  envgroup: string,
) => {
  const name = attachment.name ?? "";
  return {
    name,
    attachmentId: lastSegment(name),
    envgroup: envgroupIdOf(envgroup),
    environment: attachment.environment ?? "",
    organization: orgIdOf(organization),
    environmentGroupId: attachment.environmentGroupId,
    createdAt: attachment.createdAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsEnvgroupsAttachments({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const listAttachments = (parent: string) =>
  collectPages(
    apigee.listOrganizationsEnvgroupsAttachments.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.environmentGroupAttachments,
  ).pipe(
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed(
        [] as apigee.GoogleCloudApigeeV1EnvironmentGroupAttachment[],
      ),
    ),
  );

const findByEnvironment = (
  parent: string,
  environment: string,
  organization: string,
  envgroup: string,
) =>
  Effect.gen(function* () {
    const attachments = yield* listAttachments(parent);
    const match = attachments.find(
      (attachment) => attachment.environment === environment,
    );
    return match === undefined
      ? undefined
      : toAttrs(match, organization, envgroup);
  });

export const EnvgroupsAttachmentProvider = () =>
  Provider.succeed(EnvgroupsAttachment, {
    stables: [
      "name",
      "attachmentId",
      "envgroup",
      "environment",
      "organization",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousGroup = olds?.envgroup ?? output?.envgroup;
      const previousEnv = olds?.environment ?? output?.environment;
      const previousOrg = olds?.organization ?? output?.organization;
      const groupChanged =
        previousGroup !== undefined &&
        envgroupIdOf(news.envgroup) !== envgroupIdOf(previousGroup);
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      if (groupChanged || envChanged || orgChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const envgroup = olds?.envgroup ?? output?.envgroup;
      const environment = olds?.environment ?? output?.environment;
      if (envgroup === undefined || environment === undefined) return undefined;
      const parent = parentOf(organization, envgroup);
      if (output?.name !== undefined) {
        const existing = yield* getByName(output.name);
        if (existing !== undefined) {
          return toAttrs(existing, organization, envgroup);
        }
      }
      return yield* findByEnvironment(
        parent,
        environmentIdOf(environment),
        organization,
        envgroup,
      );
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: EnvgroupsAttachment["Attributes"][] = [];
        for (const organization of orgs) {
          const groups = yield* collectPages(
            apigee.listOrganizationsEnvgroups.pages({
              parent: organization,
              pageSize: 1000,
            }),
            (page) => page.environmentGroups,
          ).pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed(
                [] as apigee.GoogleCloudApigeeV1EnvironmentGroup[],
              ),
            ),
          );
          const org = yield* apigee
            .getOrganizations({ name: organization })
            .pipe(
              Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                Effect.succeed(undefined),
              ),
            );
          const ownedEnvs = new Set<string>();
          for (const environmentId of org?.environments ?? []) {
            const environment = yield* apigee
              .getOrganizationsEnvironments({
                name: `${organization}/environments/${environmentId}`,
              })
              .pipe(
                Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                  Effect.succeed(undefined),
                ),
              );
            if (hasOwnershipMarker(environment?.description)) {
              ownedEnvs.add(environmentId);
            }
          }
          for (const group of groups) {
            const envgroupId = lastSegment(group.name ?? "");
            if (envgroupId.length === 0) continue;
            const parent = `${organization}/envgroups/${envgroupId}`;
            const attachments = yield* listAttachments(parent);
            for (const attachment of attachments) {
              const environment = attachment.environment ?? "";
              if (ownedEnvs.has(environment)) {
                rows.push(toAttrs(attachment, organization, envgroupId));
              }
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const envgroup = envgroupIdOf(news.envgroup);
      const environment = environmentIdOf(news.environment);
      const parent = parentOf(organization, envgroup);

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;
      if (current === undefined) {
        const found = yield* findByEnvironment(
          parent,
          environment,
          organization,
          envgroup,
        );
        if (found !== undefined) {
          current = yield* getByName(found.name);
        }
      }

      if (current === undefined) {
        const operation = yield* apigee
          .createOrganizationsEnvgroupsAttachments({
            parent,
            body: { environment },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          const done = yield* waitForOperation(operation);
          const createdName = stringField(done.response, "name");
          if (createdName !== undefined) {
            current = yield* getByName(createdName);
          }
        }
        if (current === undefined) {
          const found = yield* findByEnvironment(
            parent,
            environment,
            organization,
            envgroup,
          );
          if (found !== undefined) {
            current = yield* getByName(found.name);
          }
        }
      }

      if (current === undefined) {
        return yield* new EnvgroupsAttachmentNotResolved({
          parent,
          environment,
        });
      }

      return toAttrs(current, organization, envgroup);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigee
        .deleteOrganizationsEnvgroupsAttachments({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
