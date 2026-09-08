import type * as lambda from "@distilled.cloud/aws/lambda";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { sha256, sha256Object } from "../../Util/sha256.ts";
import { zipFiles, type ZipFile } from "../../Util/zip.ts";
import type { Providers } from "../Providers.ts";

/**
 * Reference to an S3 bucket: a raw bucket name or anything exposing a
 * `bucketName` attribute (e.g. an `AWS.S3.Bucket` resource).
 */
export type BucketRef = string | { bucketName: string };

/** Resolve a {@link BucketRef} to its bucket name. */
const bucketNameOf = (bucket: BucketRef): string =>
  typeof bucket === "string" ? bucket : bucket.bucketName;

/**
 * Layer content stored in S3. Use this instead of {@link LayerVersionProps.path}
 * for archives larger than the 50 MB direct-upload limit.
 */
export interface LayerVersionS3Content {
  /**
   * S3 bucket holding the layer archive — an `AWS.S3.Bucket` resource or a
   * raw bucket name.
   */
  bucket: BucketRef;
  /** Key of the layer archive object. */
  key: string;
  /** Version id of the object, for versioned buckets. */
  objectVersion?: string;
}

export interface LayerVersionProps {
  /**
   * Name of the layer. If omitted, a unique name is generated.
   */
  layerName?: string;
  /**
   * Local path to the layer content — either a directory whose contents are
   * packaged into a zip archive, or an existing `.zip` file uploaded as-is.
   *
   * Layer archives are extracted into `/opt` at runtime, so the directory's
   * layout must match the runtime's convention (e.g. `nodejs/node_modules`
   * for Node.js dependencies, `bin/` for executables). File modes are
   * preserved, so executables keep their `+x` bit.
   *
   * Exactly one of `path` or {@link s3} is required.
   */
  path?: string;
  /**
   * Layer content already uploaded to S3. Required for archives above the
   * 50 MB direct-upload limit.
   *
   * Exactly one of {@link path} or `s3` is required.
   */
  s3?: LayerVersionS3Content;
  /**
   * Description of this version of the layer.
   */
  description?: string;
  /**
   * Runtimes the layer is compatible with. Used to filter the layer in the
   * console; Lambda does not enforce it.
   */
  compatibleRuntimes?: lambda.Runtime[];
  /**
   * Instruction set architectures the layer is compatible with.
   */
  compatibleArchitectures?: lambda.Architecture[];
  /**
   * The layer's software license — an SPDX identifier, a URL, or the full
   * license text.
   */
  licenseInfo?: string;
}

export interface LayerVersion extends Resource<
  "AWS.Lambda.LayerVersion",
  LayerVersionProps,
  {
    /**
     * Name of the layer.
     */
    layerName: string;
    /**
     * ARN of the layer (without a version suffix).
     */
    layerArn: string;
    /**
     * ARN of this specific layer version. This is what
     * {@link FunctionProps.layers} takes.
     */
    layerVersionArn: string;
    /**
     * Version number assigned by Lambda.
     */
    version: number;
    /**
     * Hash of the packaged content and publish configuration. Any change to
     * it publishes a new version, since layer versions are immutable.
     */
    sourceHash: string;
    /**
     * Base64-encoded SHA-256 of the layer archive, as reported by Lambda.
     */
    codeSha256?: string;
    /**
     * Size of the layer archive in bytes.
     */
    codeSize?: number;
    /**
     * Date the version was created, in ISO-8601 format.
     */
    createdDate?: string;
    /**
     * Description of the version.
     */
    description?: string;
    /**
     * Runtimes the layer is compatible with.
     */
    compatibleRuntimes?: lambda.Runtime[];
    /**
     * Architectures the layer is compatible with.
     */
    compatibleArchitectures?: lambda.Architecture[];
    /**
     * The layer's software license.
     */
    licenseInfo?: string;
  },
  never,
  Providers
> {}

/**
 * A version of a Lambda layer — a zip archive of libraries, a custom runtime,
 * or other dependencies that Lambda extracts into `/opt` alongside your
 * function code.
 *
 * Layer versions are immutable, so changing the content or any publish
 * setting publishes a new version under the same layer and retires the one
 * it supersedes. `layerVersionArn` and `version` therefore change on update;
 * `layerName` and `layerArn` stay put.
 *
 * ### Publishing a Layer
 * **Example:** Package a Local Directory
 * ```typescript
 * // ./layers/deps contains nodejs/node_modules/...
 * const deps = yield* LayerVersion("Deps", {
 *   path: "./layers/deps",
 *   compatibleRuntimes: ["nodejs22.x"],
 * });
 * ```
 *
 * **Example:** Publish an Existing Archive
 * ```typescript
 * const layer = yield* LayerVersion("Ffmpeg", {
 *   path: "./dist/ffmpeg-layer.zip",
 *   description: "static ffmpeg build",
 *   compatibleArchitectures: ["arm64"],
 * });
 * ```
 *
 * **Example:** Publish From S3
 * ```typescript
 * const layer = yield* LayerVersion("BigLayer", {
 *   s3: {
 *     bucket,
 *     key: "layers/big-layer.zip",
 *   },
 * });
 * ```
 *
 * ### Attaching to a Function
 * **Example:** Use a Layer in a Function
 * ```typescript
 * const fn = yield* Function("Handler", {
 *   main: import.meta.resolve("./handler.ts"),
 *   layers: [deps],
 * });
 * ```
 *
 * @resource
 */
export const LayerVersion = Resource<LayerVersion>("AWS.Lambda.LayerVersion");

/**
 * Lambda rejects a `PublishLayerVersion` request whose inline archive exceeds
 * 50 MB — larger archives must go through S3.
 */
const MAX_INLINE_ARCHIVE_SIZE = 50 * 1024 * 1024;

export const LayerVersionProvider = () =>
  Provider.effect(
    LayerVersion,
    Effect.gen(function* () {
      const createLayerName = (id: string, layerName?: string) =>
        layerName
          ? Effect.succeed(layerName)
          : createPhysicalName({
              id,
              // Layer names are limited to 140 characters.
              maxLength: 140,
              delimiter: "-",
            });

      /**
       * Read `directory` recursively into deterministic zip entries, keeping
       * each file's unix mode so executables stay executable under `/opt`.
       */
      const readDirectoryEntries = Effect.fn(function* (directory: string) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const names = yield* fs.readDirectory(directory, { recursive: true });
        const entries = yield* Effect.forEach(
          names,
          Effect.fn(function* (name) {
            const file = path.join(directory, name);
            const info = yield* fs.stat(file);
            if (info.type !== "File") return [];
            return [
              {
                // Zip archives always use forward slashes.
                path: name.replaceAll("\\", "/"),
                content: yield* fs.readFile(file),
                mode: info.mode,
              } satisfies ZipFile,
            ];
          }),
          { concurrency: 16 },
        );
        return entries.flat();
      });

      /**
       * Resolve the props' content into a `PublishLayerVersion` payload plus
       * a hash of everything that would force a new version.
       */
      const packageContent = Effect.fn(function* (props: LayerVersionProps) {
        const config = {
          description: props.description,
          compatibleRuntimes: props.compatibleRuntimes,
          compatibleArchitectures: props.compatibleArchitectures,
          licenseInfo: props.licenseInfo,
        };
        if (props.s3 && props.path) {
          return yield* Effect.die(
            "AWS.Lambda.LayerVersion accepts either `path` or `s3`, not both.",
          );
        }
        if (props.s3) {
          // Hash the resolved coordinates, not the props, so a bucket passed
          // as a resource and the same bucket passed by name agree.
          const s3 = {
            S3Bucket: bucketNameOf(props.s3.bucket),
            S3Key: props.s3.key,
            S3ObjectVersion: props.s3.objectVersion,
          } satisfies lambda.LayerVersionContentInput;
          return {
            content: s3,
            sourceHash: yield* sha256Object({ s3, config }),
          };
        }
        if (!props.path) {
          return yield* Effect.die(
            "AWS.Lambda.LayerVersion requires either `path` or `s3`.",
          );
        }
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolved = path.resolve(props.path);
        const info = yield* fs.stat(resolved);
        if (info.type !== "Directory" && path.extname(resolved) !== ".zip") {
          return yield* Effect.die(
            `AWS.Lambda.LayerVersion \`path\` must be a directory or a .zip archive: ${resolved}`,
          );
        }
        const archive =
          info.type === "Directory"
            ? yield* zipFiles(yield* readDirectoryEntries(resolved))
            : yield* fs.readFile(resolved);
        if (archive.byteLength > MAX_INLINE_ARCHIVE_SIZE) {
          return yield* Effect.die(
            `AWS.Lambda.LayerVersion archive is ${archive.byteLength} bytes, above Lambda's ${MAX_INLINE_ARCHIVE_SIZE} byte direct-upload limit. Upload it to S3 and use \`s3\` instead.`,
          );
        }
        return {
          content: {
            ZipFile: new Uint8Array(archive),
          } satisfies lambda.LayerVersionContentInput,
          // Hash the archive bytes rather than the source path so the same
          // content checked out at a different path does not republish.
          sourceHash: yield* sha256Object({
            archive: yield* sha256(archive),
            config,
          }),
        };
      });

      const snapshot = (
        layerName: string,
        sourceHash: string,
        // `listLayerVersions` items carry the same fields as a
        // `getLayerVersion` response minus `LayerArn`/`Content`, so both
        // shapes snapshot through here.
        version: lambda.GetLayerVersionResponse | lambda.LayerVersionsListItem,
      ): LayerVersion["Attributes"] | undefined => {
        if (!version.LayerVersionArn || !version.Version) {
          return undefined;
        }
        const layerArn =
          ("LayerArn" in version ? version.LayerArn : undefined) ??
          // `arn:…:layer:{name}:{version}` — the layer ARN is the version ARN
          // without its trailing version segment.
          version.LayerVersionArn.slice(
            0,
            version.LayerVersionArn.lastIndexOf(":"),
          );
        const content = "Content" in version ? version.Content : undefined;
        return {
          layerName,
          layerArn,
          layerVersionArn: version.LayerVersionArn,
          version: version.Version,
          sourceHash,
          codeSha256: content?.CodeSha256,
          codeSize: content?.CodeSize,
          createdDate: version.CreatedDate,
          description: version.Description || undefined,
          compatibleRuntimes: version.CompatibleRuntimes,
          compatibleArchitectures: version.CompatibleArchitectures,
          licenseInfo: version.LicenseInfo,
        };
      };

      const getVersion = (layerName: string, version: number) =>
        Lambda.getLayerVersion({
          LayerName: layerName,
          VersionNumber: version,
        }).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        // `layerVersionArn`/`version` deliberately are NOT stable: an update
        // publishes a new version under the same layer.
        stables: ["layerName", "layerArn"],
        // A layer version is immutable, but the *layer* is not: publishing
        // re-uses the layer name and mints version N+1. So a content or
        // config change is an UPDATE, not a replacement — a replacement would
        // mint a fresh instance id, hence a fresh layer name, and every
        // change would strand a new layer stuck at version 1.
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          if (!output) return undefined;
          // Auto-generated names are engine-owned: the published layer's name
          // stays authoritative even if the generator would name this id
          // differently today. Only an explicit `layerName` forces a replace.
          if ((news.layerName ?? output.layerName) !== output.layerName) {
            return { action: "replace" } as const;
          }
          const { sourceHash } = yield* packageContent(news);
          if (
            sourceHash !== output.sourceHash ||
            olds.description !== news.description ||
            olds.licenseInfo !== news.licenseInfo ||
            !deepEqual(olds.compatibleRuntimes, news.compatibleRuntimes) ||
            !deepEqual(
              olds.compatibleArchitectures,
              news.compatibleArchitectures,
            )
          ) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const version = yield* getVersion(output.layerName, output.version);
          return version
            ? snapshot(output.layerName, output.sourceHash, version)
            : undefined;
        }),
        list: () =>
          Effect.gen(function* () {
            // Layers carry no tags, so there is nothing to filter ownership
            // on — enumerate every version of every layer in the ambient
            // account/region.
            const layerNames = yield* Lambda.listLayers.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk)
                  .map((layer) => layer.LayerName)
                  .filter((name): name is string => name !== undefined),
              ),
            );
            const versions = yield* Effect.forEach(
              layerNames,
              (layerName) =>
                Lambda.listLayerVersions.items({ LayerName: layerName }).pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((version) => {
                      const attrs = snapshot(layerName, "", version);
                      return attrs ? [attrs] : [];
                    }),
                  ),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as LayerVersion["Attributes"][]),
                  ),
                ),
              { concurrency: 10 },
            );
            return versions.flat();
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const layerName =
            output?.layerName ?? (yield* createLayerName(id, news.layerName));
          const { content, sourceHash } = yield* packageContent(news);

          // Observe: an interrupted apply may have already published the
          // version recorded in state. Republishing would leak a version, so
          // reuse it when it still exists and still matches the desired
          // content.
          if (
            output?.version !== undefined &&
            output.sourceHash === sourceHash
          ) {
            const existing = yield* getVersion(layerName, output.version);
            const attrs = existing && snapshot(layerName, sourceHash, existing);
            if (attrs) return attrs;
          }

          const published = yield* Lambda.publishLayerVersion({
            LayerName: layerName,
            Content: content,
            Description: news.description,
            CompatibleRuntimes: news.compatibleRuntimes,
            CompatibleArchitectures: news.compatibleArchitectures,
            LicenseInfo: news.licenseInfo,
          });

          const attrs = snapshot(layerName, sourceHash, published);
          if (!attrs) {
            return yield* Effect.die(
              `Lambda layer ${layerName} did not return complete attributes.`,
            );
          }

          // Retire the version this one supersedes, so an update doesn't
          // leak a version per deploy. Functions already referencing the old
          // version keep working — Lambda retains a copy until nothing
          // refers to it.
          if (
            output?.version !== undefined &&
            output.version !== attrs.version
          ) {
            yield* Lambda.deleteLayerVersion({
              LayerName: layerName,
              VersionNumber: output.version,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }

          yield* session.note(`Layer ${attrs.layerName}:${attrs.version}`);

          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* Lambda.deleteLayerVersion({
            LayerName: output.layerName,
            VersionNumber: output.version,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
