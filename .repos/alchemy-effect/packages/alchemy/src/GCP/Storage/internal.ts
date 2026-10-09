import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";

export const normalizeRole = (role: string) => role.trim().toUpperCase();

export const normalizeEntity = (entity: string) => entity.trim();

/** Default project-team ACL entries GCS stamps on fine-grained buckets. */
export const isProjectAclEntity = (entity: string | undefined) =>
  (entity ?? "").toLowerCase().startsWith("project-");

/**
 * ACL entities Alchemy may have created. Skips project-team defaults and
 * numeric `user-{id}` object-owner entries so `list` / nuke do not try to
 * delete GCS-managed ACLs.
 */
export const isUserManagedAclEntity = (entity: string | undefined) => {
  const value = (entity ?? "").toLowerCase();
  if (value.length === 0 || isProjectAclEntity(value)) return false;
  if (value === "allusers" || value === "allauthenticatedusers") return true;
  if (value.startsWith("domain-") || value.startsWith("group-")) return true;
  return value.startsWith("user-") && value.includes("@");
};

export const withTrailingSlash = (name: string) =>
  name.endsWith("/") ? name : `${name}/`;

export const toFolderName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    const raw =
      name ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: 200,
        lowercase: true,
      }));
    return withTrailingSlash(raw.replace(/^\/+/, ""));
  });

export const listAlchemyBuckets = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    return yield* storage.listBuckets
      .items({
        project: env.project,
        projection: "full",
        maxResults: 1000,
      })
      .pipe(
        Stream.filter((bucket) =>
          Object.keys(bucket.labels ?? {}).some((key) =>
            key.startsWith(ALCHEMY_LABEL_PREFIX),
          ),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  });
