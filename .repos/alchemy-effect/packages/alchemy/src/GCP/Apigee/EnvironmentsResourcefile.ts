import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  emptyOnMissing,
  environmentIdOf,
  environmentNameOf,
  lastSegment,
  listProjectEnvironments,
  missingToUndefined,
  organizationIdOf,
  stripRevision,
  toResourceId,
} from "./common.ts";

const MAX_NAME_LENGTH = 255;
const DEFAULT_TYPE = "js";

export type EnvironmentsResourcefileProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the file.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the file.
   */
  environment: string;
  /**
   * Resource file type (`js`, `java`, `properties`, `py`, `xsl`, `wsdl`,
   * `xsd`, …). Immutable — changing it replaces the file.
   * @default "js"
   */
  fileType?: string;
  /**
   * File id. If omitted, a unique name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the file.
   */
  fileId?: string;
  /**
   * File contents as UTF-8 text. Sent as `google.api.HttpBody`.
   */
  content?: string;
};

export type EnvironmentsResourcefile = Resource<
  "GCP.Apigee.EnvironmentsResourcefile",
  EnvironmentsResourcefileProps,
  {
    /** Parent environment `organizations/{org}/environments/{env}`. */
    parent: string;
    /** File id. */
    fileId: string;
    /** Resource file type. */
    fileType: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
  },
  never,
  Providers
>;

/**
 * An environment-scoped Apigee resource file (JavaScript, Java, XSL, …).
 *
 * Resource files have no labels. `list` enumerates files in Apigee
 * environments mapped to this GCP project. Type and name are identity;
 * `content` updates in place.
 *
 * ### Creating a JavaScript File
 * **Example:** Generated name
 * ```typescript
 * const file = yield* GCP.Apigee.EnvironmentsResourcefile("Helper", {
 *   environment: "eval",
 *   fileType: "js",
 *   content: "function helper() { return 1; }",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsResourcefile = Resource<EnvironmentsResourcefile>(
  "GCP.Apigee.EnvironmentsResourcefile",
);

export class EnvironmentsResourcefileNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsResourcefileNotResolved",
)<{
  parent: string;
  fileType: string;
  fileId: string;
}> {}

const fileTypeOf = (value: string | undefined) => value ?? DEFAULT_TYPE;

const toAttrs = (
  fileId: string,
  fileType: string,
  organizationId: string,
  environmentId: string,
) => ({
  parent: environmentNameOf(organizationId, environmentId),
  fileId,
  fileType,
  organizationId,
  environmentId,
});

const toHttpBody = (content: string) =>
  Effect.sync((): apigee.GoogleApiHttpBody => ({
    contentType: "application/octet-stream",
    data: Buffer.from(content, "utf8").toString("base64"),
  }));

const getById = (parent: string, type: string, name: string) =>
  missingToUndefined(
    apigee.getOrganizationsEnvironmentsResourcefiles({
      parent,
      type,
      name,
    }),
  );

const listFiles = (parent: string, type?: string) =>
  emptyOnMissing(
    apigee.listOrganizationsEnvironmentsResourcefiles({
      parent,
      type,
    }),
    { resourceFile: [] as apigee.GoogleCloudApigeeV1ResourceFileList },
  );

const hasFile = (
  files: readonly apigee.GoogleCloudApigeeV1ResourceFile[] | undefined,
  fileId: string,
  fileType: string,
) =>
  (files ?? []).some(
    (file) =>
      lastSegment(stripRevision(file.name ?? "")) === fileId &&
      (file.type === undefined || file.type === fileType),
  );

export const EnvironmentsResourcefileProvider = () =>
  Provider.succeed(EnvironmentsResourcefile, {
    stables: [
      "parent",
      "fileId",
      "fileType",
      "organizationId",
      "environmentId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.fileId ?? output?.fileId;
      const previousType = olds?.fileType ?? output?.fileType;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.fileId !== undefined &&
        news.fileId !== previousId;
      const typeChanged =
        previousType !== undefined &&
        news.fileType !== undefined &&
        fileTypeOf(news.fileType) !== fileTypeOf(previousType);
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      if (idChanged || typeChanged || orgChanged || envChanged) {
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
      const fileType = fileTypeOf(olds?.fileType ?? output?.fileType);
      const fileId = yield* toResourceId(id, olds?.fileId, output?.fileId, {
        maxLength: MAX_NAME_LENGTH,
      });
      const parent =
        output?.parent ?? environmentNameOf(organizationId, environmentId);
      const existing = yield* getById(parent, fileType, fileId);
      if (existing === undefined) return undefined;
      return toAttrs(fileId, fileType, organizationId, environmentId);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsResourcefile["Attributes"][] = [];
        for (const item of environments) {
          const page = yield* listFiles(item.parent);
          for (const file of page.resourceFile ?? []) {
            if (!file.name) continue;
            found.push(
              toAttrs(
                lastSegment(stripRevision(file.name)),
                file.type ?? DEFAULT_TYPE,
                item.organizationId,
                item.environmentId,
              ),
            );
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const fileType = fileTypeOf(news.fileType);
      const fileId = yield* toResourceId(id, news.fileId, output?.fileId, {
        maxLength: MAX_NAME_LENGTH,
      });
      const parent = environmentNameOf(organizationId, environmentId);
      const body = yield* toHttpBody(news.content ?? "");

      let current = yield* getById(parent, fileType, fileId);

      if (current === undefined) {
        yield* apigee
          .createOrganizationsEnvironmentsResourcefiles({
            parent,
            type: fileType,
            name: fileId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getById(parent, fileType, fileId),
            ),
          );
        current = yield* getById(parent, fileType, fileId);
      } else if (news.content !== undefined) {
        yield* apigee.updateOrganizationsEnvironmentsResourcefiles({
          parent,
          type: fileType,
          name: fileId,
          body,
        });
      }

      const listed = yield* listFiles(parent, fileType);
      if (
        current === undefined &&
        !hasFile(listed.resourceFile, fileId, fileType)
      ) {
        return yield* new EnvironmentsResourcefileNotResolved({
          parent,
          fileType,
          fileId,
        });
      }

      return toAttrs(fileId, fileType, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsResourcefiles({
          parent: output.parent,
          type: output.fileType,
          name: output.fileId,
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
