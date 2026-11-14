import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { mobileSourceMapKey, type MobilePlatform } from "@t3tools/shared/mobileSourceMaps";
import { AwsClient } from "aws4fetch";

export interface SourceMapUpload {
  readonly key: string;
  readonly path: string;
}

/** The `MOBILE_SOURCEMAPS_R2` secret: the relay stack's `mobileSourceMapsUploadCredentials`. */
interface UploadCredentials {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // JSON.parse's message quotes the input, which here is the secret.
    throw new Error("MOBILE_SOURCEMAPS_R2 is not valid JSON.");
  }
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

/** One map per update `eas update --emit-metadata` published, next to the bundle `metadata.json` names. */
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
        key: mobileSourceMapKey(update.platform, "ota", update.id),
        path: NodePath.join(distDir, `${bundle}.map`),
      },
    ];
  });
}

/** Android's Gradle plugin writes the map under the release variant; iOS to `SOURCEMAP_FILE` (eas.json). */
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
    return { key: mobileSourceMapKey("ios", "build", buildId), path: env.SOURCEMAP_FILE };
  }
  const variantsDir = NodePath.join(projectDir, "android/app/build/generated/sourcemaps/react");
  const variant = NodeFS.existsSync(variantsDir)
    ? NodeFS.readdirSync(variantsDir).find((name) => /release$/iu.test(name))
    : undefined;
  if (!variant) throw new Error(`No release source map under ${variantsDir}.`);
  return {
    key: mobileSourceMapKey("android", "build", buildId),
    path: NodePath.join(variantsDir, variant, "index.android.bundle.map"),
  };
}

/**
 * EAS writes the app's debug symbols next to the `.ipa`, so native frames in iOS crash
 * reports can be read with `atos`. Undefined when the build left none.
 */
export function buildDsymUpload(
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
): SourceMapUpload | undefined {
  if (env.EAS_BUILD_PLATFORM !== "ios" || !env.EAS_BUILD_ID) return undefined;
  const buildDir = NodePath.join(projectDir, "ios/build");
  const dsym = NodeFS.existsSync(buildDir)
    ? NodeFS.readdirSync(buildDir).find((name) => name.endsWith(".app.dSYM.zip"))
    : undefined;
  if (!dsym) return undefined;
  return { key: `ios/dsym/${env.EAS_BUILD_ID}.zip`, path: NodePath.join(buildDir, dsym) };
}

/** Only what the relay reads: source text stays out of the bucket, and the rest is dead weight. */
function stripToMappings(text: string): string {
  const map: unknown = JSON.parse(text);
  if (!isRecord(map)) throw new Error("Source map is not a JSON object.");
  const { version, sources, sourceRoot, mappings } = map;
  return JSON.stringify({ version, sources, sourceRoot, mappings });
}

export function uploadSourceMap(
  credentials: UploadCredentials,
  upload: SourceMapUpload,
): Promise<number> {
  return putObject(
    credentials,
    upload.key,
    stripToMappings(NodeFS.readFileSync(upload.path, "utf8")),
    "application/json",
  );
}

export function uploadDsym(credentials: UploadCredentials, upload: SourceMapUpload) {
  const body = new Uint8Array(NodeFS.readFileSync(upload.path));
  return putObject(credentials, upload.key, body, "application/zip");
}

async function putObject(
  credentials: UploadCredentials,
  key: string,
  body: string | Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<number> {
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = `${credentials.endpoint.replace(/\/$/u, "")}/${credentials.bucketName}/${key}`;
  const response = await client.fetch(url, {
    method: "PUT",
    body,
    headers: { "content-type": contentType },
  });
  if (!response.ok) {
    throw new Error(`R2 answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return body.length;
}
