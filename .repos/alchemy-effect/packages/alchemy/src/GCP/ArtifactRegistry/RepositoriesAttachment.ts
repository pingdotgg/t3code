import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ResourceNotResolved,
  expandRepository,
  hasAlchemyLabelMap,
  listAlchemyRepositories,
  listAttachments,
  listChildResources,
  locationFromRepository,
  missingGet,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  sameJson,
  sameText,
  sortedStrings,
  toPhysicalId,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const DEFAULT_TYPE = "application/json";

export type RepositoriesAttachmentProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the attachment.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the repository's location, else the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Attachment id (the `{attachment}` segment of
   * `.../repositories/{repository}/attachments/{attachment}`). If omitted,
   * a unique name is generated. Immutable — changing it replaces the
   * attachment.
   */
  attachmentId?: string;
  /**
   * Target the attachment is for — a Version, Package, or Repository
   * resource name. Bare ids are resolved under `repository`. Immutable —
   * changing it replaces the attachment.
   */
  target: string;
  /**
   * Files that belong to this attachment, as File resource names or file
   * ids under `repository`. Immutable — changing them replaces the
   * attachment.
   */
  files: string[];
  /**
   * Attachment type, for example `application/vnd.spdx+json`.
   * @default "application/json"
   */
  type?: string;
  /**
   * Namespace this attachment belongs to, for example
   * `artifactanalysis.googleapis.com`.
   */
  attachmentNamespace?: string;
  /**
   * User annotations. Alchemy ownership keys (`alchemy-stack`,
   * `alchemy-stage`, `alchemy-id`) are merged in automatically.
   * Attachments have no labels field and no update API — changing
   * annotations replaces the attachment.
   */
  annotations?: Record<string, string>;
};

export type RepositoriesAttachment = Resource<
  "GCP.ArtifactRegistry.RepositoriesAttachment",
  RepositoriesAttachmentProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/repositories/{repository}/attachments/{attachment}`. */
    name: string;
    /** Attachment id (last path segment). */
    attachmentId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`). */
    location: string;
    /** Target resource name. */
    target: string | undefined;
    /** File resource names on this attachment. */
    files: string[];
    /** Attachment type. */
    type: string | undefined;
    /** Attachment namespace. */
    attachmentNamespace: string | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** OCI version created for Docker attachments, if any. */
    ociVersionName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * Artifact Registry metadata attached to a repository, package, or
 * version. An attachment points at one or more files already stored in
 * the repository.
 *
 * Attachments have no update API — any change replaces the resource.
 * Alchemy stamps ownership into `annotations` so `list` / nuke can find
 * them.
 *
 * ### Creating a RepositoriesAttachment
 * **Example:** Attach an SBOM file to a repository
 * ```typescript
 * const attachment = yield* GCP.ArtifactRegistry.RepositoriesAttachment(
 *   "Sbom",
 *   {
 *     repository: artifacts.name,
 *     target: artifacts.name,
 *     type: "application/spdx+json",
 *     files: [sbomFileName],
 *     annotations: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category ArtifactRegistry
 */
export const RepositoriesAttachment = Resource<RepositoriesAttachment>(
  "GCP.ArtifactRegistry.RepositoriesAttachment",
);

const expandTarget = (repository: string, target: string) => {
  const next = target.replace(/\/+$/, "");
  if (next.includes("/")) return next;
  return `${repository}/packages/${next}`;
};

const expandFile = (repository: string, file: string) => {
  const next = file.replace(/\/+$/, "");
  if (next.includes("/files/")) return next;
  return `${repository}/files/${next}`;
};

const resourceNameOf = (repository: string, attachmentId: string) =>
  `${repository}/attachments/${attachmentId}`;

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(annotations));

const toAttrs = (
  attachment: artifactregistry.Attachment,
  project: string,
  region: string,
) => {
  const name = attachment.name ?? "";
  const parsed = parseName(name, "attachments", region);
  return {
    name,
    attachmentId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    target: attachment.target,
    files: [...(attachment.files ?? [])],
    type: attachment.type,
    attachmentNamespace: attachment.attachmentNamespace,
    annotations: userAnnotations(attachment.annotations),
    ociVersionName: attachment.ociVersionName,
    createTime: attachment.createTime,
    updateTime: attachment.updateTime,
  };
};

const getByName = missingGet(
  artifactregistry.getProjectsLocationsRepositoriesAttachments,
);

export const RepositoriesAttachmentProvider = () =>
  Provider.succeed(RepositoriesAttachment, {
    stables: [
      "name",
      "attachmentId",
      "repository",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.attachmentId ?? output?.attachmentId;
      const nextId = news.attachmentId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ??
          locationFromRepository(news.repository, previousLocation),
        env.region,
      );
      const extra =
        !sameText(olds?.target ?? output?.target, news.target) ||
        JSON.stringify(sortedStrings(olds?.files ?? output?.files)) !==
          JSON.stringify(sortedStrings(news.files)) ||
        !sameText(olds?.type ?? output?.type, news.type ?? DEFAULT_TYPE) ||
        !sameText(
          olds?.attachmentNamespace ?? output?.attachmentNamespace,
          news.attachmentNamespace,
        ) ||
        !sameJson(
          olds?.annotations ?? output?.annotations ?? {},
          news.annotations ?? {},
        );
      return replaceOnIdentity({
        previousId,
        nextId,
        previousLocation,
        nextLocation,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: news.repository,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          locationFromRepository(
            olds?.repository ?? output?.repository,
            env.region,
          ),
        env.region,
      );
      const repository = expandRepository(
        olds?.repository ?? output?.repository ?? "",
        env.project,
        location,
      );
      const attachmentId = yield* toPhysicalId(
        id,
        olds?.attachmentId,
        output?.attachmentId,
        "attachment",
      );
      const name = output?.name ?? resourceNameOf(repository, attachmentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.annotations)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const repos = yield* listAlchemyRepositories(env.project);
        const attachments = yield* listChildResources(repos, listAttachments);
        return attachments
          .filter((attachment) => hasAlchemyLabelMap(attachment.annotations))
          .map((attachment) => toAttrs(attachment, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromRepository(news.repository, env.region),
        env.region,
      );
      const repository = expandRepository(
        news.repository,
        env.project,
        location,
      );
      const attachmentId = yield* toPhysicalId(
        id,
        news.attachmentId,
        output?.attachmentId,
        "attachment",
      );
      const name = resourceNameOf(repository, attachmentId);
      const target = expandTarget(repository, news.target);
      const files = news.files.map((file) => expandFile(repository, file));
      const type = news.type ?? DEFAULT_TYPE;
      const attachmentNamespace = news.attachmentNamespace;
      const annotations = {
        ...tagRecord(news.annotations),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* artifactregistry
          .createProjectsLocationsRepositoriesAttachments({
            parent: repository,
            attachmentId,
            body: {
              target,
              files,
              type,
              attachmentNamespace,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* artifactregistry
        .deleteProjectsLocationsRepositoriesAttachments({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
