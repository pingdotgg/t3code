import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  environmentIdOf,
  environmentNameOf,
  lastSegment,
  listProjectEnvironments,
  missingToUndefined,
  organizationIdOf,
  parseOrgEnv,
  toResourceId,
} from "./common.ts";
import { waitForOperation } from "./operations.ts";

const MAX_NAME_LENGTH = 63;

export type EnvironmentsArchiveDeploymentProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the
   * deployment.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. The
   * environment must use archive deployment. Immutable — changing it
   * replaces the deployment.
   */
  environment: string;
  /**
   * Archive deployment id (last path segment). If omitted, a unique name
   * is generated. Immutable — changing it replaces the deployment.
   */
  archiveDeploymentId?: string;
  /**
   * Signed GCS URI from `generateUploadUrl`, or a `gs://` object that
   * already holds the archive zip. Input-only.
   */
  gcsUri?: string;
  /**
   * Base64-encoded archive zip. When `gcsUri` is omitted, Alchemy calls
   * generateUploadUrl and PUTs these bytes to the signed URL.
   */
  archiveZip?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type EnvironmentsArchiveDeployment = Resource<
  "GCP.Apigee.EnvironmentsArchiveDeployment",
  EnvironmentsArchiveDeploymentProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/archiveDeployments/{id}`. */
    name: string;
    /** Archive deployment id. */
    archiveDeploymentId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Create LRO name, if still reported. */
    operation: string | undefined;
    /** Create time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Update time in milliseconds since epoch. */
    updatedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee archive deployment — a zip of API proxies deployed as a unit
 * to an archive-mode environment.
 *
 * Labels carry Alchemy ownership so `list` / nuke can find leaked rows.
 * Name is identity; labels update in place. Creating an archive is a
 * long-running operation.
 *
 * ### Creating an Archive Deployment
 * **Example:** Upload a zip
 * ```typescript
 * const archive = yield* GCP.Apigee.EnvironmentsArchiveDeployment("Bundle", {
 *   environment: "eval",
 *   archiveZip: zipBase64,
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsArchiveDeployment =
  Resource<EnvironmentsArchiveDeployment>(
    "GCP.Apigee.EnvironmentsArchiveDeployment",
  );

export class EnvironmentsArchiveDeploymentNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsArchiveDeploymentNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organizationId: string,
  environmentId: string,
  archiveDeploymentId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/archiveDeployments/${archiveDeploymentId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (
  archive: apigee.GoogleCloudApigeeV1ArchiveDeployment,
  organizationId: string,
  environmentId: string,
) => {
  const raw = archive.name ?? "";
  const parsed = parseOrgEnv(raw);
  const archiveDeploymentId = lastSegment(raw);
  return {
    name: raw.includes("/")
      ? raw
      : resourceName(organizationId, environmentId, archiveDeploymentId || raw),
    archiveDeploymentId: archiveDeploymentId || raw,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    labels: userLabels(archive.labels),
    operation: archive.operation,
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
  };
};

const getByName = (name: string) =>
  missingToUndefined(
    apigee.getOrganizationsEnvironmentsArchiveDeployments({ name }),
  );

const uploadZip = (uploadUri: string, archiveZip: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const bytes = yield* Effect.sync(() => Buffer.from(archiveZip, "base64"));
    const response = yield* client.execute(
      HttpClientRequest.put(uploadUri).pipe(
        HttpClientRequest.bodyUint8Array(bytes, "application/zip"),
      ),
    );
    if (response.status >= 400) {
      return yield* new EnvironmentsArchiveDeploymentNotResolved({
        name: uploadUri,
      });
    }
    return uploadUri;
  });

export const EnvironmentsArchiveDeploymentProvider = () =>
  Provider.succeed(EnvironmentsArchiveDeployment, {
    stables: [
      "name",
      "archiveDeploymentId",
      "organizationId",
      "environmentId",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.archiveDeploymentId ?? output?.archiveDeploymentId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.archiveDeploymentId !== undefined &&
        news.archiveDeploymentId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      if (idChanged || orgChanged || envChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(
        olds?.organization ?? output?.organizationId,
        project,
      );
      const environmentId = environmentIdOf(
        olds?.environment ?? output?.environmentId ?? "",
      );
      const archiveDeploymentId = yield* toResourceId(
        id,
        olds?.archiveDeploymentId,
        output?.archiveDeploymentId,
        { maxLength: MAX_NAME_LENGTH, rfc1035: true },
      );
      const name =
        output?.name ??
        resourceName(organizationId, environmentId, archiveDeploymentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organizationId, environmentId);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsArchiveDeployment["Attributes"][] = [];
        for (const item of environments) {
          const archives =
            yield* apigee.listOrganizationsEnvironmentsArchiveDeployments
              .pages({ parent: item.parent, pageSize: 100 })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.archiveDeployments ?? []),
                ),
                Stream.filter((archive) =>
                  Object.keys(archive.labels ?? {}).some((key) =>
                    key.startsWith("alchemy-"),
                  ),
                ),
                Stream.map((archive) =>
                  toAttrs(archive, item.organizationId, item.environmentId),
                ),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                  Effect.succeed(
                    [] as EnvironmentsArchiveDeployment["Attributes"][],
                  ),
                ),
              );
          found.push(...archives);
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const archiveDeploymentId = yield* toResourceId(
        id,
        news.archiveDeploymentId,
        output?.archiveDeploymentId,
        { maxLength: MAX_NAME_LENGTH, rfc1035: true },
      );
      const parent = environmentNameOf(organizationId, environmentId);
      const name = resourceName(
        organizationId,
        environmentId,
        archiveDeploymentId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        let gcsUri = news.gcsUri;
        if (gcsUri === undefined && news.archiveZip !== undefined) {
          const upload =
            yield* apigee.generateUploadUrlOrganizationsEnvironmentsArchiveDeployments(
              { parent, body: {} },
            );
          if (upload.uploadUri) {
            gcsUri = yield* uploadZip(upload.uploadUri, news.archiveZip);
          }
        }
        const operation = yield* apigee
          .createOrganizationsEnvironmentsArchiveDeployments({
            parent,
            body: {
              name,
              gcsUri,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<apigee.GoogleLongrunningOperation>({
                done: true,
              }),
            ),
          );
        if (operation.name || operation.done !== true) {
          yield* waitForOperation(operation);
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new EnvironmentsArchiveDeploymentNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        current =
          yield* apigee.patchOrganizationsEnvironmentsArchiveDeployments({
            name: current.name ?? name,
            updateMask: "labels",
            body: { labels: desiredLabels },
          });
      }

      return toAttrs(current, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsArchiveDeployments({
          name: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
