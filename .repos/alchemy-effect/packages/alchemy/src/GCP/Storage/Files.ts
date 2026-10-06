import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { initialCwd } from "../../Util/Node.ts";
import { Object } from "./Object.ts";

export interface FilesProps {
  /** Bucket that receives the files. */
  bucketName: Input<string>;
  /**
   * Local directory to upload, resolved against the working directory the
   * deploy started in. Every regular file below it becomes one object.
   */
  path: string;
  /** Key prefix prepended to every object name (no leading/trailing `/`). */
  prefix?: string;
  /**
   * `Cache-Control` for every object, or a function of the object key.
   * @default Cloud Storage's `public, max-age=3600` for public objects
   */
  cacheControl?: string | ((key: string) => string | undefined);
}

/**
 * Upload a local directory into a Cloud Storage bucket: one
 * {@link Object} per file, keyed by its POSIX path relative to `path`,
 * with `Content-Type` inferred from the extension. Files removed from the
 * directory are deleted from the bucket on the next deploy (their
 * `Object` resources become orphans).
 *
 * ### Uploading a site
 * **Example:** Upload `./dist` with no-cache HTML
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("Site", { forceDestroy: true });
 * const objects = yield* GCP.Storage.Files("SiteFiles", {
 *   bucketName: bucket.bucketName,
 *   path: "./dist",
 *   cacheControl: (key) =>
 *     key.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const Files = (id: string, props: FilesProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(initialCwd, props.path);
      const prefix = (props.prefix ?? "").replace(/^\/+|\/+$/g, "");
      const entries = yield* fs.readDirectory(root, { recursive: true });
      const files: string[] = [];
      for (const entry of entries) {
        const info = yield* fs.stat(path.join(root, entry));
        if (info.type === "File") files.push(entry.replaceAll("\\", "/"));
      }
      files.sort();
      // Logical ids are the URI-encoded relative path so `/` never clashes
      // with the FQN separator and distinct paths never collide.
      return yield* Effect.forEach(files, (relative) => {
        const key = prefix ? `${prefix}/${relative}` : relative;
        return Object(encodeURIComponent(relative), {
          bucketName: props.bucketName,
          key,
          file: path.join(root, relative),
          cacheControl:
            typeof props.cacheControl === "function"
              ? props.cacheControl(key)
              : props.cacheControl,
        });
      });
    }).pipe(
      // An unreadable site directory is a stack authoring error.
      Effect.catchTag("PlatformError", (error) =>
        Effect.die(
          new Error(
            `GCP.Storage.Files(${id}): cannot read ${props.path}: ${error.message}`,
          ),
        ),
      ),
    ),
  );
