import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lastSegment, orgParent, organizationFromName } from "./names.ts";
import { waitForOperation } from "./operations.ts";
import { listOwnedInstances } from "./org.ts";

export type InstancesAttachmentProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the attachment.
   */
  organization?: string;
  /**
   * Parent instance id or full name
   * (`organizations/{org}/instances/{instance}`). Immutable — changing it
   * replaces the attachment.
   */
  instance: string;
  /**
   * Environment id to attach. Immutable — changing it replaces the
   * attachment.
   */
  environment: string;
};

export type InstancesAttachment = Resource<
  "GCP.Apigee.InstancesAttachment",
  InstancesAttachmentProps,
  {
    /** Full resource name `organizations/{org}/instances/{instance}/attachments/{attachment}`. */
    name: string;
    /** Attachment id (last path segment). */
    attachmentId: string;
    /** Parent instance id. */
    instanceId: string;
    /** Attached environment id. */
    environment: string;
    /** Apigee organization id. */
    organization: string;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An attachment of an Apigee environment onto a runtime instance.
 *
 * Attachments have no labels or description. `list` enumerates
 * attachments on alchemy-owned instances so `pnpm nuke:gcp` can find
 * leaked rows. Organization, instance, and environment are identity —
 * changing them replaces the attachment. There is nothing else to
 * update in place.
 *
 * ### Creating an Attachment
 * **Example:** Attach an environment to a runtime instance
 * ```typescript
 * const runtime = yield* GCP.Apigee.Instance("Runtime", {});
 * const attachment = yield* GCP.Apigee.InstancesAttachment("Eval", {
 *   instance: runtime.name,
 *   environment: "eval",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const InstancesAttachment = Resource<InstancesAttachment>(
  "GCP.Apigee.InstancesAttachment",
);

export class InstancesAttachmentNotResolved extends Data.TaggedError(
  "GCP.Apigee.InstancesAttachmentNotResolved",
)<{
  name: string;
}> {}

const instanceIdOf = (instance: string) => lastSegment(instance);

const instanceName = (organization: string, instance: string) =>
  instance.includes("/")
    ? instance
    : `${orgParent(organization)}/instances/${instance}`;

const resourceName = (
  organization: string,
  instance: string,
  attachmentId: string,
) => `${instanceName(organization, instance)}/attachments/${attachmentId}`;

const toAttrs = (
  attachment: apigee.GoogleCloudApigeeV1InstanceAttachment,
  organization: string,
  instanceId: string,
) => {
  const raw = attachment.name ?? "";
  const name = raw.includes("/")
    ? raw
    : resourceName(organization, instanceId, raw);
  return {
    name,
    attachmentId: lastSegment(name),
    instanceId,
    environment: attachment.environment ?? "",
    organization: organizationFromName(name) ?? organization,
    createdAt: attachment.createdAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsInstancesAttachments({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const listByInstance = (parent: string) =>
  apigee.listOrganizationsInstancesAttachments
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.attachments ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([] as apigee.GoogleCloudApigeeV1InstanceAttachment[]),
      ),
    );

const findByEnvironment = (
  parent: string,
  environment: string,
  organization: string,
  instanceId: string,
) =>
  listByInstance(parent).pipe(
    Effect.map((attachments) =>
      attachments.find((attachment) => attachment.environment === environment),
    ),
    Effect.map((attachment) =>
      attachment === undefined
        ? undefined
        : toAttrs(attachment, organization, instanceId),
    ),
  );

export const InstancesAttachmentProvider = () =>
  Provider.succeed(InstancesAttachment, {
    stables: [
      "name",
      "attachmentId",
      "instanceId",
      "organization",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousInstance = olds?.instance ?? output?.instanceId;
      const previousEnv = olds?.environment ?? output?.environment;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousInstance !== undefined &&
          instanceIdOf(news.instance) !== instanceIdOf(previousInstance)) ||
        (previousEnv !== undefined && news.environment !== previousEnv) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const instanceId = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      if (instanceId.length === 0) return undefined;
      const parent = instanceName(organization, instanceId);
      if (output?.name !== undefined) {
        const existing = yield* getByName(output.name);
        if (existing === undefined) return undefined;
        return toAttrs(existing, organization, instanceId);
      }
      const environment = olds?.environment ?? output?.environment;
      if (environment === undefined) return undefined;
      const found = yield* findByEnvironment(
        parent,
        environment,
        organization,
        instanceId,
      );
      return found;
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* listOwnedInstances(env.project);
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const parent = instance.name?.includes("/")
              ? instance.name
              : `${orgParent(env.project)}/instances/${lastSegment(instance.name ?? "")}`;
            const instanceId = lastSegment(parent);
            return listByInstance(parent).pipe(
              Effect.map((attachments) =>
                attachments.map((attachment) =>
                  toAttrs(attachment, env.project, instanceId),
                ),
              ),
            );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const instanceId = instanceIdOf(news.instance);
      const parent = instanceName(organization, instanceId);
      const existingName = output?.name;

      let current =
        existingName !== undefined ? yield* getByName(existingName) : undefined;
      if (current === undefined) {
        const found = yield* findByEnvironment(
          parent,
          news.environment,
          organization,
          instanceId,
        );
        if (found !== undefined) {
          current = yield* getByName(found.name);
        }
      }

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsInstancesAttachments({
            parent,
            body: { environment: news.environment },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        const found = yield* findByEnvironment(
          parent,
          news.environment,
          organization,
          instanceId,
        );
        if (found === undefined) {
          return yield* new InstancesAttachmentNotResolved({
            name: `${parent}/attachments/${news.environment}`,
          });
        }
        return found;
      }

      return toAttrs(current, organization, instanceId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const deleted = yield* apigee
        .deleteOrganizationsInstancesAttachments({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, { notFoundOk: true });
      }
    }),
  });
