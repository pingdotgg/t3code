// @effect-diagnostics nodeBuiltinImport:off - Vite's build plugin runs before an Effect runtime exists.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";

import type { Plugin } from "vite-plus";

export const THIRD_PARTY_LICENSES_FILE_NAME = "third-party-licenses.json";

export interface ThirdPartyLicenseEntry {
  readonly bundles: ReadonlyArray<string>;
  readonly kind: "custom" | "package";
  readonly license: string;
  readonly name: string;
  readonly noticeText: string;
  readonly sourceUrl: string | null;
  readonly version: string | null;
}

export interface ThirdPartyLicenseManifest {
  readonly schemaVersion: 1;
  readonly entries: ReadonlyArray<ThirdPartyLicenseEntry>;
}

export interface ThirdPartyLicensePackageManifest {
  readonly bundle: string;
  readonly path: string | URL;
}

export interface ThirdPartyLicensesPluginOptions {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
  readonly bundleName: string;
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly homepage?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly name?: unknown;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly repository?: unknown;
  readonly version?: unknown;
}

interface CustomNoticeConfigEntry {
  readonly bundles?: ReadonlyArray<string>;
  readonly license: string;
  readonly name: string;
  readonly noticeFile: string;
  readonly sourceUrl?: string;
  readonly version?: string;
}

interface PackageNoticeOverrideConfigEntry {
  readonly license?: string;
  readonly name?: string;
  readonly noticeFile?: string;
  readonly repositoryUrl?: string;
  readonly sourceUrl?: string;
  readonly version?: string;
}

interface ThirdPartyLicensesConfig {
  readonly customNotices: ReadonlyArray<CustomNoticeConfigEntry>;
  readonly packageOverrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>;
}

interface CollectedPackage {
  readonly bundles: Set<string>;
  readonly packageJson: PackageJson;
  readonly packageRoot: string;
}

interface PackageCollection {
  readonly byIdentity: Map<string, CollectedPackage>;
}

const EMPTY_CONFIG: ThirdPartyLicensesConfig = {
  customNotices: [],
  packageOverrides: [],
};

const NOTICE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const FIRST_PARTY_PACKAGE_PREFIX = "@t3tools/";

function asPath(value: string | URL): string {
  return value instanceof URL ? NodeURL.fileURLToPath(value) : NodePath.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${context} must define a non-empty "${key}" string.`);
  }
  return field.trim();
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${context} must define "${key}" as a non-empty string when present.`);
  }
  return field.trim();
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  context: string,
): ReadonlyArray<string> | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (
    !Array.isArray(field) ||
    field.length === 0 ||
    field.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new Error(`${context} must define "${key}" as a non-empty string array.`);
  }
  return field.map((entry) => (entry as string).trim());
}

function decodeCustomNotices(value: unknown): ReadonlyArray<CustomNoticeConfigEntry> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Third-party license config field "customNotices" must be an array.');
  }
  return value.map((entry, index) => {
    const context = `Third-party custom notice at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const version = readOptionalString(entry, "version", context);
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    const bundles = readOptionalStringArray(entry, "bundles", context);
    return {
      name: readRequiredString(entry, "name", context),
      license: readRequiredString(entry, "license", context),
      noticeFile: readRequiredString(entry, "noticeFile", context),
      ...(version !== undefined ? { version } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(bundles !== undefined ? { bundles } : {}),
    };
  });
}

function decodePackageOverrides(value: unknown): ReadonlyArray<PackageNoticeOverrideConfigEntry> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Third-party license config field "packageOverrides" must be an array.');
  }
  return value.map((entry, index) => {
    const context = `Third-party package override at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const name = readOptionalString(entry, "name", context);
    const repositoryUrl = readOptionalString(entry, "repositoryUrl", context);
    if ((name === undefined) === (repositoryUrl === undefined)) {
      throw new Error(`${context} must define exactly one of "name" or "repositoryUrl".`);
    }
    const version = readOptionalString(entry, "version", context);
    const license = readOptionalString(entry, "license", context);
    const noticeFile = readOptionalString(entry, "noticeFile", context);
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(noticeFile !== undefined ? { noticeFile } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    };
  });
}

async function readConfig(configFile: string | URL | undefined): Promise<{
  readonly config: ThirdPartyLicensesConfig;
  readonly directory: string;
}> {
  if (configFile === undefined) {
    return { config: EMPTY_CONFIG, directory: NodePath.resolve(".") };
  }
  const configPath = asPath(configFile);
  const source = await NodeFSP.readFile(configPath, "utf8");
  const decoded = JSON.parse(source) as unknown;
  if (!isRecord(decoded)) throw new Error("Third-party license config must contain an object.");
  return {
    config: {
      customNotices: decodeCustomNotices(decoded.customNotices),
      packageOverrides: decodePackageOverrides(decoded.packageOverrides),
    },
    directory: NodePath.dirname(configPath),
  };
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const source = await NodeFSP.readFile(packageJsonPath, "utf8");
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value)) throw new Error(`Package manifest is not an object: ${packageJsonPath}`);
  return value as PackageJson;
}

function packageIdentity(packageJson: PackageJson, packageRoot: string): string {
  const name =
    typeof packageJson.name === "string" ? packageJson.name : NodePath.basename(packageRoot);
  const version = typeof packageJson.version === "string" ? packageJson.version : "unknown";
  return `${name}@${version}`;
}

async function findPackageRoot(
  resolvedPath: string,
  expectedName?: string,
): Promise<{ readonly packageJson: PackageJson; readonly packageRoot: string } | null> {
  let current = NodePath.dirname(resolvedPath);
  const root = NodePath.parse(current).root;

  while (current !== root) {
    const packageJsonPath = NodePath.join(current, "package.json");
    try {
      const packageJson = await readPackageJson(packageJsonPath);
      const matchesExpectedPackage =
        expectedName !== undefined
          ? packageJson.name === expectedName
          : typeof packageJson.name === "string" && typeof packageJson.version === "string";
      if (matchesExpectedPackage) {
        return { packageJson, packageRoot: await NodeFSP.realpath(current) };
      }
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    current = NodePath.dirname(current);
  }
  return null;
}

async function resolveDependencyPackage(
  dependencyName: string,
  fromPackageJsonPath: string,
): Promise<{ readonly packageJson: PackageJson; readonly packageRoot: string } | null> {
  const requireFromPackage = NodeModule.createRequire(fromPackageJsonPath);
  const candidates = [`${dependencyName}/package.json`, dependencyName];
  for (const candidate of candidates) {
    try {
      const resolved = requireFromPackage.resolve(candidate);
      const found = await findPackageRoot(resolved, dependencyName);
      if (found) return found;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
  }
  return null;
}

function dependencyNames(packageJson: PackageJson): ReadonlyArray<string> {
  return [
    ...new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

async function collectProductionDependencyPackages(
  packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>,
): Promise<PackageCollection> {
  const collection: PackageCollection = {
    byIdentity: new Map(),
  };
  const visited = new Set<string>();

  const visitManifest = async (packageJsonPath: string, bundle: string): Promise<void> => {
    const packageJson = await readPackageJson(packageJsonPath);
    for (const dependencyName of dependencyNames(packageJson)) {
      const resolved = await resolveDependencyPackage(dependencyName, packageJsonPath);
      if (!resolved) continue;
      const visitKey = `${bundle}:${resolved.packageRoot}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const dependencyPackageJsonPath = NodePath.join(resolved.packageRoot, "package.json");
      const name =
        typeof resolved.packageJson.name === "string" ? resolved.packageJson.name : dependencyName;
      if (!name.startsWith(FIRST_PARTY_PACKAGE_PREFIX)) {
        const identity = packageIdentity(resolved.packageJson, resolved.packageRoot);
        const existing = collection.byIdentity.get(identity);
        if (existing) {
          existing.bundles.add(bundle);
        } else {
          collection.byIdentity.set(identity, {
            bundles: new Set([bundle]),
            packageJson: resolved.packageJson,
            packageRoot: resolved.packageRoot,
          });
        }
      }

      await visitManifest(dependencyPackageJsonPath, bundle);
    }
  };

  for (const manifest of packageManifests) {
    await visitManifest(asPath(manifest.path), manifest.bundle);
  }
  return collection;
}

function moduleFilePath(moduleId: string): string | null {
  if (moduleId.startsWith("\0") || moduleId.includes("\0")) return null;
  const withoutQuery = moduleId.split(/[?#]/, 1)[0] ?? moduleId;
  const filePath = withoutQuery.startsWith("file:")
    ? NodeURL.fileURLToPath(withoutQuery)
    : withoutQuery.replace(/^\/@fs\//, "/");
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.includes("/node_modules/") ? filePath : null;
}

async function addBundledModulePackages(
  collection: PackageCollection,
  moduleIds: ReadonlyArray<string>,
  bundle: string,
): Promise<void> {
  for (const moduleId of moduleIds) {
    const filePath = moduleFilePath(moduleId);
    if (!filePath) continue;
    let found: Awaited<ReturnType<typeof findPackageRoot>>;
    try {
      found = await findPackageRoot(await NodeFSP.realpath(filePath));
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if (!found || typeof found.packageJson.name !== "string") continue;
    if (found.packageJson.name.startsWith(FIRST_PARTY_PACKAGE_PREFIX)) continue;
    const identity = packageIdentity(found.packageJson, found.packageRoot);
    const existing = collection.byIdentity.get(identity);
    if (existing) {
      existing.bundles.add(bundle);
    } else {
      collection.byIdentity.set(identity, {
        bundles: new Set([bundle]),
        packageJson: found.packageJson,
        packageRoot: found.packageRoot,
      });
    }
  }
}

function normalizeLicense(packageJson: PackageJson): string | null {
  if (typeof packageJson.license === "string" && packageJson.license.trim().length > 0) {
    return packageJson.license.trim();
  }
  if (isRecord(packageJson.license) && typeof packageJson.license.type === "string") {
    return packageJson.license.type.trim() || null;
  }
  if (Array.isArray(packageJson.licenses)) {
    const licenses = packageJson.licenses
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (isRecord(entry) && typeof entry.type === "string") return entry.type.trim();
        return "";
      })
      .filter((entry) => entry.length > 0);
    if (licenses.length > 0) return licenses.join(" OR ");
  }
  return null;
}

function normalizeRepositoryUrl(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("github:")) return `https://github.com/${trimmed.slice(7)}`;
  const normalized = trimmed
    .replace(/^git\+ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/(?:git@)?github\.com\//, "https://github.com/")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) return `https://github.com/${normalized}`;
  return normalized;
}

function packageSourceUrl(packageJson: PackageJson): string | null {
  if (typeof packageJson.homepage === "string" && packageJson.homepage.trim().length > 0) {
    return packageJson.homepage.trim();
  }
  return normalizeRepositoryUrl(packageJson.repository);
}

async function readPackageNoticeText(packageRoot: string): Promise<string | null> {
  const noticeFiles: string[] = [];
  const rootEntries = await NodeFSP.readdir(packageRoot, { withFileTypes: true });
  noticeFiles.push(
    ...rootEntries
      .filter((entry) => entry.isFile() && NOTICE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name),
  );

  const collectNestedNoticeFiles = async (directory: string, depth: number): Promise<void> => {
    const directoryEntries = await NodeFSP.readdir(NodePath.join(packageRoot, directory), {
      withFileTypes: true,
    });
    await Promise.all(
      directoryEntries.map(async (entry) => {
        const relativePath = NodePath.join(directory, entry.name);
        if (entry.isFile() && NOTICE_FILE_PATTERN.test(entry.name)) {
          noticeFiles.push(relativePath);
          return;
        }
        if (
          depth > 0 &&
          entry.isDirectory() &&
          entry.name !== "node_modules" &&
          entry.name !== ".git"
        ) {
          await collectNestedNoticeFiles(relativePath, depth - 1);
        }
      }),
    );
  };
  if (noticeFiles.length === 0) {
    await Promise.all(
      rootEntries
        .filter(
          (entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git",
        )
        .map((entry) => collectNestedNoticeFiles(entry.name, 2)),
    );
  }
  noticeFiles.sort((left, right) => left.localeCompare(right));
  if (noticeFiles.length === 0) return null;

  const sections: string[] = [];
  for (const fileName of noticeFiles) {
    const contents = (await NodeFSP.readFile(NodePath.join(packageRoot, fileName), "utf8")).trim();
    if (contents.length === 0) continue;
    sections.push(noticeFiles.length === 1 ? contents : `${fileName}\n\n${contents}`);
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

function repositoryNoticeKey(packageJson: PackageJson, license: string): string | null {
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository);
  return repositoryUrl
    ? `${repositoryUrl.toLocaleLowerCase()}\n${license.toLocaleLowerCase()}`
    : null;
}

async function collectRepositoryNotices(
  collection: PackageCollection,
  packageNotices: Map<string, Promise<string | null>>,
): Promise<ReadonlyMap<string, string>> {
  const notices = new Map<string, string>();
  await Promise.all(
    [...collection.byIdentity.values()].map(async (collected) => {
      const license = normalizeLicense(collected.packageJson);
      if (!license) return;
      const key = repositoryNoticeKey(collected.packageJson, license);
      if (!key || notices.has(key)) return;
      const noticeText = await packageNoticeText(collected.packageRoot, packageNotices);
      if (noticeText) notices.set(key, noticeText);
    }),
  );
  return notices;
}

function packageNoticeText(
  packageRoot: string,
  cache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  const existing = cache.get(packageRoot);
  if (existing) return existing;
  const notice = readPackageNoticeText(packageRoot);
  cache.set(packageRoot, notice);
  return notice;
}

function findPackageOverride(
  overrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>,
  name: string,
  version: string,
  packageJson: PackageJson,
): PackageNoticeOverrideConfigEntry | undefined {
  const matchingVersion = (override: PackageNoticeOverrideConfigEntry) =>
    override.version === undefined || override.version === version;
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository)?.toLocaleLowerCase();
  return (
    overrides.find((override) => override.name === name && override.version === version) ??
    overrides.find((override) => override.name === name && override.version === undefined) ??
    overrides.find(
      (override) =>
        repositoryUrl !== undefined &&
        override.repositoryUrl !== undefined &&
        normalizeRepositoryUrl(override.repositoryUrl)?.toLocaleLowerCase() === repositoryUrl &&
        matchingVersion(override),
    )
  );
}

async function packageEntry(
  collected: CollectedPackage,
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  packageNotices: Map<string, Promise<string | null>>,
  repositoryNotices: ReadonlyMap<string, string>,
): Promise<ThirdPartyLicenseEntry> {
  const name =
    typeof collected.packageJson.name === "string"
      ? collected.packageJson.name
      : NodePath.basename(collected.packageRoot);
  const version =
    typeof collected.packageJson.version === "string" ? collected.packageJson.version : "unknown";
  const override = findPackageOverride(
    config.packageOverrides,
    name,
    version,
    collected.packageJson,
  );
  const license = override?.license ?? normalizeLicense(collected.packageJson);
  if (!license || /^(?:unlicensed|proprietary)$/i.test(license)) {
    throw new Error(
      `${name}@${version} does not declare a distributable license. Add a package override in the third-party license config if the package publishes its notice elsewhere.`,
    );
  }

  const repositoryKey = repositoryNoticeKey(collected.packageJson, license);
  const noticeText = override?.noticeFile
    ? (
        await NodeFSP.readFile(NodePath.resolve(configDirectory, override.noticeFile), "utf8")
      ).trim()
    : ((await packageNoticeText(collected.packageRoot, packageNotices)) ??
      (repositoryKey ? repositoryNotices.get(repositoryKey) : undefined));
  if (!noticeText) {
    throw new Error(
      `${name}@${version} does not include a license or notice file. Add a package override with "noticeFile" in the third-party license config.`,
    );
  }

  return {
    bundles: [...collected.bundles].sort((left, right) => left.localeCompare(right)),
    kind: "package",
    license,
    name,
    noticeText,
    sourceUrl: override?.sourceUrl ?? packageSourceUrl(collected.packageJson),
    version,
  };
}

async function customEntries(
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  includedBundles: ReadonlySet<string>,
): Promise<ReadonlyArray<ThirdPartyLicenseEntry>> {
  return Promise.all(
    config.customNotices
      .filter(
        (notice) =>
          notice.bundles === undefined ||
          notice.bundles.some((bundle) => includedBundles.has(bundle)),
      )
      .map(async (notice) => {
        const noticeText = (
          await NodeFSP.readFile(NodePath.resolve(configDirectory, notice.noticeFile), "utf8")
        ).trim();
        if (noticeText.length === 0) {
          throw new Error(`Custom third-party notice "${notice.name}" is empty.`);
        }
        return {
          bundles: [...(notice.bundles ?? ["assets"])].sort((left, right) =>
            left.localeCompare(right),
          ),
          kind: "custom" as const,
          license: notice.license,
          name: notice.name,
          noticeText,
          sourceUrl: notice.sourceUrl ?? null,
          version: notice.version ?? null,
        };
      }),
  );
}

function entrySort(left: ThirdPartyLicenseEntry, right: ThirdPartyLicenseEntry): number {
  return (
    left.name.localeCompare(right.name) ||
    (left.version ?? "").localeCompare(right.version ?? "") ||
    left.kind.localeCompare(right.kind)
  );
}

export async function generateThirdPartyLicenseManifest(input: {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
  readonly bundledModuleIds?: ReadonlyArray<string>;
  readonly bundleName?: string;
}): Promise<ThirdPartyLicenseManifest> {
  const [{ config, directory }, collection] = await Promise.all([
    readConfig(input.configFile),
    collectProductionDependencyPackages(input.packageManifests),
  ]);
  if (input.bundledModuleIds && input.bundleName) {
    await addBundledModulePackages(collection, input.bundledModuleIds, input.bundleName);
  }

  const packageNotices = new Map<string, Promise<string | null>>();
  const repositoryNotices = await collectRepositoryNotices(collection, packageNotices);

  const packageEntryResults = await Promise.allSettled(
    [...collection.byIdentity.values()].map((collected) =>
      packageEntry(collected, config, directory, packageNotices, repositoryNotices),
    ),
  );
  const failures = packageEntryResults.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(
      `Third-party license generation found ${String(failures.length)} invalid package notice${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const packageEntries = packageEntryResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const includedBundles = new Set(input.packageManifests.map((manifest) => manifest.bundle));
  if (input.bundleName) includedBundles.add(input.bundleName);
  const manualEntries = await customEntries(config, directory, includedBundles);
  return {
    schemaVersion: 1,
    entries: [...packageEntries, ...manualEntries].sort(entrySort),
  };
}

function moduleIdsFromBundle(bundle: unknown): ReadonlyArray<string> {
  const ids = new Set<string>();
  if (!isRecord(bundle)) return [];
  for (const output of Object.values(bundle)) {
    if (!isRecord(output) || output.type !== "chunk" || !isRecord(output.modules)) continue;
    for (const id of Object.keys(output.modules)) ids.add(id);
  }
  return [...ids];
}

function serializeManifest(manifest: ThirdPartyLicenseManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

export function thirdPartyLicensesPlugin(options: ThirdPartyLicensesPluginOptions): Plugin {
  return {
    name: "t3code:third-party-licenses",
    configureServer(server) {
      let manifestPromise: Promise<ThirdPartyLicenseManifest> | null = null;
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== `/${THIRD_PARTY_LICENSES_FILE_NAME}`) {
          next();
          return;
        }
        manifestPromise ??= generateThirdPartyLicenseManifest({
          packageManifests: options.packageManifests,
          ...(options.configFile !== undefined ? { configFile: options.configFile } : {}),
        });
        void manifestPromise.then(
          (manifest) => {
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(serializeManifest(manifest));
          },
          (error: unknown) => {
            next(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
    async generateBundle(_outputOptions, bundle) {
      const manifest = await generateThirdPartyLicenseManifest({
        packageManifests: options.packageManifests,
        bundledModuleIds: moduleIdsFromBundle(bundle),
        bundleName: options.bundleName,
        ...(options.configFile !== undefined ? { configFile: options.configFile } : {}),
      });
      this.emitFile({
        type: "asset",
        fileName: THIRD_PARTY_LICENSES_FILE_NAME,
        source: serializeManifest(manifest),
      });
    },
  };
}
