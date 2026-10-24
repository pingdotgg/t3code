/**
 * Finds the JavaScript source maps for a published OTA update or a finished
 * EAS build and uploads them to the relay's R2 bucket, where the relay reads
 * them to symbolicate crash stacks (infra/relay/src/mobileTelemetry).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { AwsClient } from "aws4fetch";

export type MobilePlatform = "ios" | "android";

/** Must match `sourceMapKey` in infra/relay/src/mobileTelemetry/otlpLogs.ts. */
export const sourceMapKey = (platform: MobilePlatform, kind: "ota" | "build", id: string) =>
  `${platform}/${kind}/${id}.map`;

export interface SourceMapUpload {
  readonly key: string;
  readonly path: string;
}

/** The `MOBILE_SOURCEMAPS_R2` secret: the relay stack's `mobileSourceMapsUploadCredentials`. */
export interface UploadCredentials {
  readonly endpoint: string;
  readonly bucketName: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const isPlatform = (value: unknown): value is MobilePlatform =>
  value === "ios" || value === "android";

const readJson = (path: string): unknown => JSON.parse(NodeFS.readFileSync(path, "utf8"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCredentials(value: string | undefined): UploadCredentials | undefined {
  if (!value?.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("MOBILE_SOURCEMAPS_R2 is not a JSON object.");
  const { endpoint, bucketName, accessKeyId, secretAccessKey } = parsed;
  if (
    typeof endpoint !== "string" ||
    typeof bucketName !== "string" ||
    typeof accessKeyId !== "string" ||
    typeof secretAccessKey !== "string"
  ) {
    throw new Error(
      "MOBILE_SOURCEMAPS_R2 needs endpoint, bucketName, accessKeyId and secretAccessKey.",
    );
  }
  return { endpoint, bucketName, accessKeyId, secretAccessKey };
}

/**
 * The maps for the updates `eas update --emit-metadata` just published, one
 * per update. Expo's `metadata.json` names each platform's bundle, and the
 * export writes the map next to it.
 */
export function otaSourceMapUploads(distDir: string): ReadonlyArray<SourceMapUpload> {
  const metadata = readJson(NodePath.join(distDir, "metadata.json"));
  const easMetadata = readJson(NodePath.join(distDir, "eas-update-metadata.json"));
  const fileMetadata = isRecord(metadata) ? metadata.fileMetadata : undefined;
  const updates = isRecord(easMetadata) ? easMetadata.updates : undefined;
  if (!isRecord(fileMetadata) || !Array.isArray(updates)) {
    throw new Error(`${distDir} is missing Expo export or EAS update metadata.`);
  }
  return updates.flatMap((update): Array<SourceMapUpload> => {
    if (!isRecord(update) || !isPlatform(update.platform) || typeof update.id !== "string") {
      return [];
    }
    const platformFiles = fileMetadata[update.platform];
    const bundle = isRecord(platformFiles) ? platformFiles.bundle : undefined;
    if (typeof bundle !== "string") return [];
    return [
      {
        key: sourceMapKey(update.platform, "ota", update.id),
        path: NodePath.join(distDir, `${bundle}.map`),
      },
    ];
  });
}

/**
 * The embedded bundle's map for the EAS build this runs in. React Native's
 * Gradle plugin writes Android's composed Hermes map under the release
 * variant; iOS writes it to `SOURCEMAP_FILE`, set in eas.json.
 */
export function buildSourceMapUpload(
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
): SourceMapUpload {
  const platform = env.EAS_BUILD_PLATFORM;
  const buildId = env.EAS_BUILD_ID;
  if (!isPlatform(platform) || !buildId) {
    throw new Error("EAS_BUILD_PLATFORM and EAS_BUILD_ID are only set on EAS Build.");
  }
  if (platform === "ios") {
    if (!env.SOURCEMAP_FILE) throw new Error("SOURCEMAP_FILE is not set for this iOS build.");
    return { key: sourceMapKey("ios", "build", buildId), path: env.SOURCEMAP_FILE };
  }
  const variantsDir = NodePath.join(projectDir, "android/app/build/generated/sourcemaps/react");
  const variant = NodeFS.existsSync(variantsDir)
    ? NodeFS.readdirSync(variantsDir).find((name) => /release$/iu.test(name))
    : undefined;
  if (!variant) throw new Error(`No release source map under ${variantsDir}.`);
  return {
    key: sourceMapKey("android", "build", buildId),
    path: NodePath.join(variantsDir, variant, "index.android.bundle.map"),
  };
}

/** Source text stays out of the bucket; positions and file names are enough. */
export function stripSourcesContent(text: string): string {
  const map: unknown = JSON.parse(text);
  if (!isRecord(map)) throw new Error("Source map is not a JSON object.");
  const { sourcesContent: _sourcesContent, ...rest } = map;
  return JSON.stringify(rest);
}

export async function uploadSourceMap(
  credentials: UploadCredentials,
  upload: SourceMapUpload,
): Promise<number> {
  const body = stripSourcesContent(NodeFS.readFileSync(upload.path, "utf8"));
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = `${credentials.endpoint.replace(/\/$/u, "")}/${credentials.bucketName}/${upload.key}`;
  const response = await client.fetch(url, {
    method: "PUT",
    body,
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`R2 answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return body.length;
}
