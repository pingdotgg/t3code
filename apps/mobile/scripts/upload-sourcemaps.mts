#!/usr/bin/env node
/**
 * Uploads mobile JavaScript source maps so the relay can symbolicate crashes.
 *
 *   node scripts/upload-sourcemaps.mts ota dist   # after `eas update --emit-metadata`
 *   node scripts/upload-sourcemaps.mts build      # EAS Build's eas-build-on-success hook
 *
 * Credentials come from the MOBILE_SOURCEMAPS_R2 secret. A missing secret or
 * map, or a failed upload, is a warning and never a failure: an unreadable
 * stack is not worth failing a store build or an OTA publish over.
 */
import {
  buildSourceMapUpload,
  otaSourceMapUploads,
  parseCredentials,
  uploadSourceMap,
  type SourceMapUpload,
} from "./sourcemap-upload.mts";

const warn = (message: string) => {
  // GitHub Actions shows this as an annotation; elsewhere it is a log line.
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main() {
  const [mode, distDir] = process.argv.slice(2);
  const credentials = parseCredentials(process.env.MOBILE_SOURCEMAPS_R2);
  if (!credentials) {
    warn("MOBILE_SOURCEMAPS_R2 is not set; crash stacks from this bundle stay minified.");
    return;
  }
  let uploads: ReadonlyArray<SourceMapUpload>;
  if (mode === "ota" && distDir) {
    uploads = otaSourceMapUploads(distDir);
  } else if (mode === "build") {
    uploads = [buildSourceMapUpload(process.env, process.cwd())];
  } else {
    throw new Error("Usage: upload-sourcemaps.mts ota <dist-dir> | build");
  }
  if (uploads.length === 0) warn("Found no source maps to upload.");
  for (const upload of uploads) {
    try {
      const bytes = await uploadSourceMap(credentials, upload);
      console.log(`Uploaded ${upload.key} (${(bytes / 1e6).toFixed(1)} MB)`);
    } catch (error) {
      warn(`Could not upload ${upload.key}: ${errorMessage(error)}`);
    }
  }
}

await main().catch((error: unknown) => {
  warn(`Source map upload skipped: ${errorMessage(error)}`);
});
