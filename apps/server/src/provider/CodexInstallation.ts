// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import {
  ProviderDriverKind,
  type ProviderInstallState,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";

export const DRIVER = ProviderDriverKind.make("codex");
export const STAGING_STALE_AFTER_MS = 24 * 60 * 60_000;
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u));
export const ActiveRelease = Schema.Struct({ version: Version });
export const InstalledRelease = Schema.Struct({
  version: Version,
  target: Schema.String,
  sha256: Schema.String,
});
export const PackageManifest = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  version: Version,
  target: Schema.String,
  entrypoint: Schema.String,
});
export const decodeVersion = Schema.decodeUnknownEffect(Version);
export const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));
export const encodeActive = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
export interface CodexReleaseAsset {
  readonly version: string;
  readonly target: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
}
const RELEASES: Readonly<Record<string, CodexReleaseAsset>> = {
  "darwin-arm64": {
    version: "0.166.0",
    target: "aarch64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-apple-darwin.tar.gz",
    sha256: "55a440cb579f970abe7c79ab181e54b0ea4c419be99f333bbd868eebac9c21f0",
    archiveBytes: 165951869,
  },
  "darwin-x64": {
    version: "0.166.0",
    target: "x86_64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-apple-darwin.tar.gz",
    sha256: "1cb65690230be5982c654ba2655e3a3b594dce9c55b780e78bfdfeff829d7ad9",
    archiveBytes: 180076524,
  },
  "linux-arm64": {
    version: "0.166.0",
    target: "aarch64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-unknown-linux-musl.tar.gz",
    sha256: "7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6",
    archiveBytes: 187370368,
  },
  "linux-x64": {
    version: "0.166.0",
    target: "x86_64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
    sha256: "1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254",
    archiveBytes: 199694962,
  },
  "win32-arm64": {
    version: "0.166.0",
    target: "aarch64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-pc-windows-msvc.tar.gz",
    sha256: "9383152a72f97bb5dd148493c8214e4fed38d805aa2c3297cb3739f7f130becf",
    archiveBytes: 187024318,
  },
  "win32-x64": {
    version: "0.166.0",
    target: "x86_64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
    sha256: "d559bb88e74d471265857b93b7f19bc250dae527673b9191b33534478093f6bc",
    archiveBytes: 202589789,
  },
};
export const resolveCodexReleaseAsset = (platform: NodeJS.Platform, arch: string) =>
  RELEASES[`${platform}-${arch}`] ?? null;
export class CodexInstallationError extends Schema.TaggedError<CodexInstallationError>()(
  "CodexInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
const isInstallationError = Schema.is(CodexInstallationError);
export const installationError = (operation: string, detail: string, cause?: unknown) =>
  new CodexInstallationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
export const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);
export interface CodexExecutable {
  readonly executablePath: string;
  readonly source: "managed" | "local";
  readonly version: string;
  readonly managedVersionDirectory: string | null;
}
interface CodexInstallationService {
  readonly managedDirectory: string;
  readonly resolve: () => Effect.Effect<CodexExecutable, CodexInstallationError>;
  readonly acquire: () => Effect.Effect<CodexExecutable, CodexInstallationError, Scope.Scope>;
  readonly compatibility: (
    version: string,
  ) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;
  readonly start: Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, CodexInstallationError>;
}
export class CodexInstallation extends Context.Service<
  CodexInstallation,
  CodexInstallationService
>()("t3/provider/CodexInstallation") {
  static readonly layer = Layer.effect(
    CodexInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* makeCodexInstallation({ baseDir: config.baseDir });
    }),
  );
}
export interface CodexInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CodexReleaseAsset | null;
  readonly validate?: (
    executable: CodexExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, CodexInstallationError, Scope.Scope>;
}
export const isRunning = (state: ProviderInstallState) =>
  ["downloading", "extracting", "verifying"].includes(state.phase);
export { makeCodexInstallation } from "./CodexInstallationMake.ts";
import { makeCodexInstallation } from "./CodexInstallationMake.ts";
