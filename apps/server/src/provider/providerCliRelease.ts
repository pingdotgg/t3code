import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const CliInstallDriver = Schema.Literals(["codex", "claudeAgent", "opencode"]);
export type CliInstallDriver = typeof CliInstallDriver.Type;
export const isCliInstallDriver = Schema.is(CliInstallDriver);
export class ProviderCliInstallError extends Schema.TaggedError<ProviderCliInstallError>()(
  "ProviderCliInstallError",
  {
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const decodeVersion = Schema.decodeUnknownEffect(Version);
const decodeSha256 = Schema.decodeUnknownEffect(Sha256);
const Bytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_000_000_000 }));
const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  prerelease: Schema.Boolean,
  assets: Schema.Array(
    Schema.Struct({ name: Schema.String, size: Bytes, digest: Schema.NullOr(Schema.String) }),
  ),
});
const ClaudeManifest = Schema.Struct({
  platforms: Schema.Record(Schema.String, Schema.Struct({ checksum: Sha256, size: Bytes })),
});

export interface ProviderCliRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly format: "archive" | "binary";
  readonly executable: string;
}

/** Asset names follow the upstream installers; x64 OpenCode uses its AVX2-independent build. */
export function providerCliAssetName(
  driver: "codex" | "opencode",
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch))
    return null;
  if (driver === "codex") {
    const target = `${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"}`;
    return `codex-package-${target}.tar.gz`;
  }
  return `opencode-${platform === "win32" ? "windows" : platform}-${arch}${arch === "x64" ? "-baseline" : ""}${platform === "linux" && musl ? "-musl" : ""}.${platform === "linux" ? "tar.gz" : "zip"}`;
}

/** Resolve once per explicit install/update, then verify that exact release's download. */
export const resolveProviderCliRelease = Effect.fn("resolveProviderCliRelease")(function* (
  driver: CliInstallDriver,
) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    return yield* Effect.fail(
      new ProviderCliInstallError({
        detail: `Automatic installation is unavailable for ${platform}-${arch}.`,
      }),
    );
  }
  const musl =
    platform === "linux" &&
    ((yield* fs.exists("/etc/alpine-release")) ||
      (yield* fs.exists(`/lib/ld-musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`)));
  const get = (url: string) =>
    http
      .execute(
        HttpClientRequest.get(url, {
          headers: { "user-agent": "T3-Code", accept: "application/json" },
        }),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const suffix = platform === "win32" ? ".exe" : "";
  if (driver === "claudeAgent") {
    // https://code.claude.com/docs/en/setup#install-a-specific-version
    // https://claude.ai/install.sh
    const base = "https://downloads.claude.ai/claude-code-releases";
    const version = yield* get(`${base}/stable`).pipe(
      Effect.flatMap((response) => response.text),
      Effect.flatMap((text) => decodeVersion(text.trim())),
    );
    const manifest = yield* get(`${base}/${version}/manifest.json`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ClaudeManifest)),
    );
    const target = `${platform}-${arch}${musl ? "-musl" : ""}`;
    const asset = manifest.platforms[target];
    if (!asset)
      return yield* Effect.fail(
        new ProviderCliInstallError({
          detail: `Claude does not publish a stable release for ${target}.`,
        }),
      );
    return {
      version,
      url: `${base}/${version}/${target}/claude${suffix}`,
      sha256: asset.checksum,
      bytes: asset.size,
      format: "binary",
      executable: `claude${suffix}`,
    } satisfies ProviderCliRelease;
  }
  // Codex's full package includes its companion host, resources, and ripgrep.
  // OpenCode names are documented in https://github.com/anomalyco/opencode/blob/dev/install.
  const repo = driver === "codex" ? "openai/codex" : "anomalyco/opencode";
  const release = yield* get(`https://api.github.com/repos/${repo}/releases/latest`).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(GitHubRelease)),
  );
  const version = yield* decodeVersion(release.tag_name.replace(/^(rust-v|v)/, ""));
  const name = providerCliAssetName(driver, platform, arch, musl);
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (release.prerelease || !asset)
    return yield* Effect.fail(
      new ProviderCliInstallError({
        detail: `No production ${driver} download is available for ${platform}-${arch}.`,
      }),
    );
  const sha256 = yield* decodeSha256(asset.digest?.replace(/^sha256:/, ""));
  return {
    version,
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`,
    sha256,
    bytes: asset.size,
    format: "archive",
    executable: driver === "codex" ? `bin/codex${suffix}` : `opencode${suffix}`,
  } satisfies ProviderCliRelease;
}, Effect.timeout("30 seconds"));
