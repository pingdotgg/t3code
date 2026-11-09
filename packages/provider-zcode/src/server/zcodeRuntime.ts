// @effect-diagnostics nodeBuiltinImport:off -- Catalog paths key on sha256 of the endpoint origin; Effect's crypto service adds a dependency the driver does not carry.
// Provisioning for `zcode app-server --stdio`: spawn args, catalog-backed environment, the
// account config push that makes catalog models selectable, and T3 model slug mapping.
// Everything protocol-shaped here mirrors the Phase 0 probe notes (PROTOCOL-NOTES.md).
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  zcodeRecordArray,
  zcodeRecordField,
  zcodeRecordString,
  type ZcodeRecord,
} from "./zcodeProtocol.ts";

const ZCODE_BASE_URL = "https://zcode.z.ai";

const DEFAULT_ZCODE_BINARY = "zcode";

/** The CLI filters account providers to ids present in this catalog; inventing ids breaks selection. */
export interface ZcodeAccountProviderPush {
  readonly builtinModelIds: ReadonlyArray<string>;
  readonly access: { readonly type: "zhipu-account"; readonly entitled: true };
}

export interface ZcodeAccountConfigPush {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: Record<string, ZcodeAccountProviderPush>;
  readonly states: Record<
    string,
    { readonly availability: "available"; readonly entitled: true; readonly current: boolean }
  >;
}

/** Wire shape of `model` in session/create and `modelSelection` in session/send. */
export interface ZcodeModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly options?: { readonly reasoningLevel?: string };
}

export interface ZcodeCatalogFileSet {
  readonly builtinPath?: string;
  readonly bundledPath?: string;
  readonly personalPath?: string;
  /** Parsed contents of `builtinPath`; the account config push is built from it. */
  readonly builtinCatalog?: unknown;
}

const ZCODE_ENDPOINT_HASH_LENGTH = 32;
const ZCODE_ENDPOINT_HASH = NodeCrypto.createHash("sha256")
  .update(ZCODE_BASE_URL)
  .digest("hex")
  .slice(0, ZCODE_ENDPOINT_HASH_LENGTH);

/** zcode stores CDN-refreshed catalogs under its own platform spelling, not process.platform. */
export function zcodePlatformDir(platform: NodeJS.Platform, arch: string): string | undefined {
  switch (platform) {
    case "darwin":
      return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    case "linux":
      return arch === "x64" ? "linux-x86_64" : undefined;
    case "win32":
      return arch === "x64" ? "win32-x64" : undefined;
    default:
      return undefined;
  }
}

export function zcodeDataRoot(environment: NodeJS.ProcessEnv): string | undefined {
  const root = environment.ZCODE_DATA_BASE_DIR?.trim() || environment.HOME;
  return root === undefined || root.length === 0 ? undefined : root;
}

export function zcodeBuiltinCatalogPath(input: {
  readonly root: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): string | undefined {
  const platformDir = zcodePlatformDir(input.platform, input.arch);
  if (platformDir === undefined) return undefined;
  return `${input.root}/.zcode/v2/runtime/provider/${platformDir}/${input.appVersion}/endpoint-${ZCODE_ENDPOINT_HASH}/zcode-builtin.json`;
}

export function zcodeBundledCatalogPath(root: string): string {
  return `${root}/.zcode/v2/runtime/provider/bundled/zcode-builtin.json`;
}

export function zcodePersonalProviderConfigPath(root: string): string {
  return `${root}/.zcode/v2/provider_config.json`;
}

const decodeServerCurrent = Schema.decodeUnknownOption(
  Schema.Struct({ version: Schema.optional(Schema.String) }),
);

const decodeVersionField = (entry: { readonly version?: string | undefined }) =>
  entry.version === undefined ? Option.none<string>() : Option.some(entry.version);

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Reads the appVersion the CLI pins its runtime catalog to from `<root>/.zcode/server/current.json`. */
export const readZcodeAppVersion = Effect.fn("ZcodeRuntime.readAppVersion")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  const raw = yield* fileSystem.readFileString(path).pipe(Effect.option);
  if (Option.isNone(raw)) return undefined;
  const current = Option.flatMap(decodeJsonText(raw.value), decodeServerCurrent);
  return Option.getOrUndefined(Option.flatMap(current, decodeVersionField));
});

const catalogFileExists = Effect.fn("ZcodeRuntime.catalogFileExists")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  return yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
});

/**
 * Resolves the catalog files the CLI needs through env vars. Each var is set only when its file
 * exists: the CLI fails closed on dangling paths, and with none set the adapter reports models
 * honestly unavailable instead of pretending success.
 */
export const resolveZcodeCatalogFiles = Effect.fn("ZcodeRuntime.resolveCatalogFiles")(function* (
  fileSystem: FileSystem.FileSystem,
  environment: NodeJS.ProcessEnv,
) {
  const root = zcodeDataRoot(environment);
  if (root === undefined) return {};
  const result: {
    builtinPath?: string;
    bundledPath?: string;
    personalPath?: string;
    builtinCatalog?: unknown;
  } = {};
  const appVersion = yield* readZcodeAppVersion(fileSystem, `${root}/.zcode/server/current.json`);
  if (appVersion !== undefined) {
    const builtinPath = zcodeBuiltinCatalogPath({
      root,
      appVersion,
      platform: yield* HostProcess.Platform,
      arch: yield* HostProcess.Architecture,
    });
    if (builtinPath !== undefined && (yield* catalogFileExists(fileSystem, builtinPath))) {
      result.builtinPath = builtinPath;
      const bundledPath = zcodeBundledCatalogPath(root);
      if (yield* catalogFileExists(fileSystem, bundledPath)) result.bundledPath = bundledPath;
      const raw = yield* fileSystem.readFileString(builtinPath).pipe(Effect.option);
      if (Option.isSome(raw)) {
        result.builtinCatalog = Option.getOrUndefined(decodeJsonText(raw.value));
      }
    }
  }
  const personalPath = zcodePersonalProviderConfigPath(root);
  if (yield* catalogFileExists(fileSystem, personalPath)) result.personalPath = personalPath;
  return result;
});

/**
 * The CLI requires ZCODE_BUILTIN_PROVIDER_CONFIG_FILE and ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
 * together; a builtin var without the personal one fails session startup, so the personal var
 * is dropped when its file is missing.
 */
export function zcodeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  files: ZcodeCatalogFileSet,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...environment, ZCODE_BASE_URL };
  if (files.builtinPath !== undefined) {
    next.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = files.builtinPath;
    if (files.bundledPath !== undefined) {
      next.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE = files.bundledPath;
    }
    if (files.personalPath !== undefined) {
      next.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = files.personalPath;
    }
  }
  return next;
}

/**
 * Builds the `provider/updateAccountConfig` params from the builtin catalog's zhipu-account
 * providers. `entitled: true` in both providers.access and states is what makes the registry
 * treat a model as executable; `current` marks the first provider so a default exists.
 */
export function zcodeAccountConfigPush(
  catalog: unknown,
  revision: string,
): ZcodeAccountConfigPush | undefined {
  const rules = zcodeProviderRules(catalog);
  if (rules === undefined) return undefined;
  const providers: Record<string, ZcodeAccountProviderPush> = {};
  const states: ZcodeAccountConfigPush["states"] = {};
  // Real catalogs carry a numeric revision; the wire expects the string form.
  const rawRevision = zcodeRecordField(catalog ?? {}, "revision");
  const basedOnRevision =
    typeof rawRevision === "string" && rawRevision.length > 0
      ? rawRevision
      : typeof rawRevision === "number" && Number.isFinite(rawRevision)
        ? String(Math.trunc(rawRevision))
        : "0";
  for (const rule of rules) {
    const providerId = zcodeRecordString(rule, "providerId");
    const config = zcodeRecordField(rule, "config");
    const access = Predicate.isObject(config) ? zcodeRecordField(config, "access") : undefined;
    const accessType = zcodeRecordString(access ?? {}, "type");
    const builtinModelIds = zcodeRecordStringArray(
      Predicate.isObject(config) ? zcodeRecordField(config, "builtinModelIds") : undefined,
    );
    if (
      providerId === undefined ||
      accessType !== "zhipu-account" ||
      builtinModelIds.length === 0
    ) {
      continue;
    }
    providers[providerId] = {
      builtinModelIds,
      access: { type: "zhipu-account", entitled: true },
    };
    states[providerId] = {
      availability: "available",
      entitled: true,
      current: Object.keys(providers).length === 1,
    };
  }
  if (Object.keys(providers).length === 0) return undefined;
  return {
    revision,
    basedOnZCodeBuiltinRevision: basedOnRevision,
    providers,
    states,
  };
}

/** providerRules sits at config.providerConfigRules.providerRules; tolerate a flattened copy. */
function zcodeProviderRules(catalog: unknown): ReadonlyArray<ZcodeRecord> | undefined {
  if (!Predicate.isObject(catalog)) return undefined;
  const direct = zcodeRecordArray(catalog, "providerRules");
  if (direct !== undefined) return direct.filter(Predicate.isObject);
  const config = zcodeRecordField(catalog, "config");
  if (!Predicate.isObject(config)) return undefined;
  const nested = zcodeRecordField(config, "providerConfigRules");
  if (!Predicate.isObject(nested)) return undefined;
  const rules = zcodeRecordArray(nested, "providerRules");
  return rules === undefined ? undefined : rules.filter(Predicate.isObject);
}

function zcodeRecordStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * T3 model slug → zcode ModelSelection. "default" and "default$<level>" defer to the CLI's own
 * default (undefined means omit `model`), and "<providerId>/<modelId>$<level>" maps to the
 * account provider ids the catalog carries.
 */
export function zcodeModelSelectionFromSlug(slug: string): ZcodeModelSelection | undefined {
  const trimmed = slug.trim();
  if (trimmed.length === 0 || trimmed === "default") return undefined;
  const separator = trimmed.indexOf("/");
  if (separator <= 0) return undefined;
  const providerId = trimmed.slice(0, separator);
  if (!providerId.startsWith("account:")) return undefined;
  const rest = trimmed.slice(separator + 1);
  if (rest.length === 0) return undefined;
  const dollar = rest.indexOf("$");
  if (dollar < 0) return { providerId, modelId: rest };
  const modelId = rest.slice(0, dollar);
  const reasoningLevel = rest.slice(dollar + 1);
  if (modelId.length === 0 || reasoningLevel.length === 0) return undefined;
  return { providerId, modelId, options: { reasoningLevel } };
}

export function zcodeSpawnArgs(launchArgs: string): ReadonlyArray<string> {
  return ["app-server", "--stdio", ...launchArgs.split(/\s+/).filter((arg) => arg.length > 0)];
}

/**
 * Desktop installs ship the CLI as `~/.zcode/server/bin/zcode` and often leave it off the
 * server process's PATH, so a missing `zcode` falls back to that shim before failing.
 * PATH is probed manually: resolveSpawnCommand is a no-op on POSIX and defers to exec.
 */
export const resolveZcodeLaunchCommand = Effect.fn("ZcodeRuntime.resolveLaunchCommand")(function* (
  settings: { readonly binaryPath: string },
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
) {
  const explicit = settings.binaryPath.trim();
  if (explicit.length > 0) return explicit;
  const onPath = yield* zcodeOnPath(environment, fileSystem);
  if (onPath) return DEFAULT_ZCODE_BINARY;
  const home = environment.ZCODE_DATA_BASE_DIR?.trim() || environment.HOME;
  if (home === undefined || home === "") return DEFAULT_ZCODE_BINARY;
  const desktopShim = `${home}/.zcode/server/bin/zcode`;
  const shimExists = yield* fileSystem.exists(desktopShim).pipe(Effect.orElseSucceed(() => false));
  return shimExists ? desktopShim : DEFAULT_ZCODE_BINARY;
});

const zcodeOnPath = Effect.fn("ZcodeRuntime.zcodeOnPath")(function* (
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
) {
  const pathValue = environment.PATH ?? "";
  const platform = yield* HostProcess.Platform;
  const suffixes = platform === "win32" ? ["zcode.exe", "zcode.cmd"] : ["zcode"];
  for (const dir of pathValue.split(":")) {
    if (dir === "") continue;
    for (const suffix of suffixes) {
      const found = yield* fileSystem
        .exists(`${dir}/${suffix}`)
        .pipe(Effect.orElseSucceed(() => false));
      if (found) return true;
    }
  }
  return false;
});
