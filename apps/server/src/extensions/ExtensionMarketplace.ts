import {
  type ExtensionCatalogItem,
  type ExtensionDiscoveryError,
  type ExtensionDiscoveryResult,
  type ExtensionInstallInput,
  type ExtensionInstallTarget,
  type ExtensionInstalledRecord,
  ExtensionOperationError,
  type ExtensionSettings,
  type ExtensionUninstallInput,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import type * as ServerSettingsRuntime from "../serverSettings.ts";

const GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/u;
const GITHUB_SHORTHAND_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const SKILL_FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/u;

interface GitHubRepoRef {
  readonly owner: string;
  readonly repo: string;
}

interface GitHubTreeItem {
  readonly path: string;
  readonly type: "blob" | "tree" | string;
}

const GitHubTreeResponse = Schema.Struct({
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.String,
    }),
  ),
});
type GitHubTreeResponse = typeof GitHubTreeResponse.Type;

const decodeGitHubTreeResponse = Schema.decodeUnknownSync(GitHubTreeResponse);
const isExtensionOperationError = Schema.is(ExtensionOperationError);

function parseGitHubRepoRef(sourceUrl: string): GitHubRepoRef | null {
  const trimmed = sourceUrl.trim();
  const urlMatch = trimmed.match(GITHUB_REPO_PATTERN);
  if (urlMatch) return { owner: urlMatch[1]!, repo: urlMatch[2]! };
  const shorthandMatch = trimmed.match(GITHUB_SHORTHAND_PATTERN);
  if (shorthandMatch) return { owner: shorthandMatch[1]!, repo: shorthandMatch[2]! };
  return null;
}

function normalizeRepoUrl(sourceUrl: string): string {
  const ref = parseGitHubRepoRef(sourceUrl);
  return ref ? `https://github.com/${ref.owner}/${ref.repo}` : sourceUrl;
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "extension"
  );
}

function titleizeSkillName(value: string): string {
  return value
    .replace(/^vercel-/u, "Vercel-")
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => (part === part.toUpperCase() ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ");
}

function parseSkillFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(SKILL_FRONTMATTER_PATTERN);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

function installedTargetsForItem(
  installed: ReadonlyArray<ExtensionInstalledRecord>,
  itemId: string,
): ReadonlyArray<ExtensionInstallTarget> {
  return installed.find((record) => record.id === itemId)?.targets ?? [];
}

function targetEquals(left: ExtensionInstallTarget, right: ExtensionInstallTarget): boolean {
  return left.scope === right.scope && left.providerInstanceId === right.providerInstanceId;
}

function isCodexLikeDriver(driver: string): boolean {
  return driver === "codex" || driver === "fugu";
}

function defaultCompatibilityForMarketplaceKind(kind: string): ReadonlyArray<ProviderDriverKind> {
  switch (kind) {
    case "agent-skills-repo":
    case "codex-plugin-marketplace":
      return [ProviderDriverKind.make("codex"), ProviderDriverKind.make("fugu")];
    default:
      return [];
  }
}

function providerHomePath(instance: ProviderInstanceConfig): string | null {
  const config = instance.config;
  if (config === null || typeof config !== "object") return null;
  const homePath = (config as Record<string, unknown>).homePath;
  return typeof homePath === "string" && homePath.trim().length > 0 ? homePath : null;
}

function normalizeHomePath(value: string): string {
  return value.replace(/^~(?=\/|$)/u, process.env.HOME ?? "~");
}

function fetchText(url: string, operation: ExtensionOperationError["operation"]) {
  return Effect.tryPromise({
    try: async () => {
      // @effect-diagnostics-next-line globalFetchInEffect:off - GitHub marketplace discovery is a bounded optional integration; failures are wrapped in ExtensionOperationError.
      const response = await fetch(url, {
        headers: { Accept: "application/vnd.github+json, text/plain;q=0.9, */*;q=0.8" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response.text();
    },
    catch: (cause) =>
      new ExtensionOperationError({
        operation,
        message: `Failed to fetch ${url}.`,
        cause,
      }),
  });
}

function fetchGitHubTree(repoRef: GitHubRepoRef, operation: ExtensionOperationError["operation"]) {
  return fetchText(
    `https://api.github.com/repos/${repoRef.owner}/${repoRef.repo}/git/trees/main?recursive=1`,
    operation,
  ).pipe(
    Effect.map((raw) => decodeGitHubTreeResponse(JSON.parse(raw))),
    Effect.mapError((cause) =>
      isExtensionOperationError(cause)
        ? cause
        : new ExtensionOperationError({
            operation,
            message: `Failed to read GitHub tree for ${repoRef.owner}/${repoRef.repo}.`,
            cause,
          }),
    ),
  );
}

export interface ExtensionMarketplaceService {
  readonly discover: Effect.Effect<ExtensionDiscoveryResult, ExtensionOperationError>;
  readonly install: (
    input: ExtensionInstallInput,
  ) => Effect.Effect<ExtensionDiscoveryResult, ExtensionOperationError>;
  readonly uninstall: (
    input: ExtensionUninstallInput,
  ) => Effect.Effect<ExtensionDiscoveryResult, ExtensionOperationError>;
}

export function make(input: {
  readonly serverSettings: ServerSettingsRuntime.ServerSettingsService["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): ExtensionMarketplaceService {
  const serverSettings = input.serverSettings;
  const serverConfig = input.serverConfig;
  const fs = input.fileSystem;
  const path = input.path;

  const extensionInstallRoot = path.join(serverConfig.stateDir, "extensions");
  const globalSkillsRoot = path.join(extensionInstallRoot, "global", "skills");
  const providerSkillsRoot = (providerInstanceId: string) =>
    path.join(extensionInstallRoot, "providers", providerInstanceId, "skills");

  const discoverGitHubSkills = Effect.fn("ExtensionMarketplace.discoverGitHubSkills")(function* (
    settings: ExtensionSettings,
    marketplace: ExtensionSettings["marketplaces"][number],
  ): Effect.fn.Return<ExtensionCatalogItem[], ExtensionOperationError> {
    const repoRef = parseGitHubRepoRef(marketplace.sourceUrl);
    if (!repoRef) {
      return yield* new ExtensionOperationError({
        operation: "discover",
        message: `Marketplace ${marketplace.name} is not a GitHub repository URL.`,
      });
    }

    const tree = yield* fetchGitHubTree(repoRef, "discover");
    const skillFiles = tree.tree
      .filter(
        (entry): entry is GitHubTreeItem =>
          entry.type === "blob" && /^skills\/[^/]+\/SKILL\.md$/u.test(entry.path),
      )
      .toSorted((left, right) => left.path.localeCompare(right.path));

    const items: ExtensionCatalogItem[] = [];
    for (const skillFile of skillFiles) {
      const [, skillDirectory] = skillFile.path.split("/");
      if (!skillDirectory) continue;
      const raw = yield* fetchText(
        `https://raw.githubusercontent.com/${repoRef.owner}/${repoRef.repo}/main/${skillFile.path}`,
        "discover",
      ).pipe(Effect.orElseSucceed(() => ""));
      const frontmatter = parseSkillFrontmatter(raw);
      const sourceUrl = normalizeRepoUrl(marketplace.sourceUrl);
      const name = frontmatter.name?.trim() || skillDirectory;
      const itemId = `${marketplace.id}:${slugify(name)}`;
      const description = frontmatter.description?.trim();
      items.push({
        id: itemId,
        marketplaceId: marketplace.id,
        type: "skill",
        name,
        displayName: titleizeSkillName(name),
        ...(description ? { description } : {}),
        sourceUrl,
        sourceSubpath: `skills/${skillDirectory}`,
        compatibility: [...defaultCompatibilityForMarketplaceKind(marketplace.kind)],
        tags: ["skill", repoRef.owner],
        installedTargets: [...installedTargetsForItem(settings.installed, itemId)],
      });
    }
    return items;
  });

  const discoverAll = Effect.fn("ExtensionMarketplace.discover")(function* (): Effect.fn.Return<
    ExtensionDiscoveryResult,
    ExtensionOperationError
  > {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionOperationError({
            operation: "discover",
            message: "Failed to read extension settings.",
            cause,
          }),
      ),
    );
    const marketplaces = settings.extensions.marketplaces;
    const items: ExtensionCatalogItem[] = [];
    const errors: ExtensionDiscoveryError[] = [];

    for (const marketplace of marketplaces) {
      if (!marketplace.enabled || marketplace.kind !== "agent-skills-repo") continue;
      const result = yield* discoverGitHubSkills(settings.extensions, marketplace).pipe(
        Effect.result,
      );
      if (Result.isFailure(result)) {
        errors.push({ marketplaceId: marketplace.id, message: result.failure.message });
      } else {
        items.push(...result.success);
      }
    }

    return {
      marketplaces,
      items,
      installed: settings.extensions.installed,
      errors,
    } satisfies ExtensionDiscoveryResult;
  });

  const installTargetRoot = Effect.fn("ExtensionMarketplace.installTargetRoot")(function* (
    input: ExtensionInstallInput,
    settings: ContractServerSettings,
  ): Effect.fn.Return<string, ExtensionOperationError> {
    if (input.scope === "global") return globalSkillsRoot;
    const providerInstanceId = input.providerInstanceId;
    if (!providerInstanceId) {
      return yield* new ExtensionOperationError({
        operation: "install",
        message: "Provider-scoped installs require a provider instance.",
      });
    }
    const instance = settings.providerInstances[providerInstanceId];
    if (instance && !isCodexLikeDriver(instance.driver)) {
      return yield* new ExtensionOperationError({
        operation: "install",
        message: `Provider ${providerInstanceId} does not expose a native skill install location yet.`,
      });
    }
    const configuredHomePath = instance ? providerHomePath(instance) : null;
    return configuredHomePath
      ? path.join(normalizeHomePath(configuredHomePath), "skills")
      : providerSkillsRoot(providerInstanceId);
  });

  const materializeSkill = Effect.fn("ExtensionMarketplace.materializeSkill")(function* (
    item: ExtensionCatalogItem,
    targetRoot: string,
  ): Effect.fn.Return<void, ExtensionOperationError> {
    const repoRef = parseGitHubRepoRef(item.sourceUrl);
    if (!repoRef || !item.sourceSubpath) {
      return yield* new ExtensionOperationError({
        operation: "install",
        message: `Extension ${item.name} does not have an installable GitHub skill source.`,
      });
    }
    const tree = yield* fetchGitHubTree(repoRef, "install");
    const sourcePrefix = `${item.sourceSubpath}/`;
    const files = tree.tree.filter(
      (entry) => entry.type === "blob" && entry.path.startsWith(sourcePrefix),
    );
    const destination = path.join(targetRoot, slugify(item.name));
    yield* fs.makeDirectory(destination, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionOperationError({
            operation: "install",
            message: `Failed to prepare extension directory for ${item.name}.`,
            cause,
          }),
      ),
    );
    for (const file of files) {
      const relative = file.path.slice(sourcePrefix.length);
      if (!relative || relative.includes("..")) continue;
      const destinationFile = path.join(destination, relative);
      yield* fs.makeDirectory(path.dirname(destinationFile), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ExtensionOperationError({
              operation: "install",
              message: `Failed to prepare extension file path for ${item.name}.`,
              cause,
            }),
        ),
      );
      const contents = yield* fetchText(
        `https://raw.githubusercontent.com/${repoRef.owner}/${repoRef.repo}/main/${file.path}`,
        "install",
      );
      yield* writeFileStringAtomically({ filePath: destinationFile, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ExtensionOperationError({
              operation: "install",
              message: `Failed to write extension file for ${item.name}.`,
              cause,
            }),
        ),
      );
    }
  });

  const install = Effect.fn("ExtensionMarketplace.install")(function* (
    input: ExtensionInstallInput,
  ): Effect.fn.Return<ExtensionDiscoveryResult, ExtensionOperationError> {
    const before = yield* discoverAll();
    const item = before.items.find(
      (candidate) =>
        candidate.id === input.itemId && candidate.marketplaceId === input.marketplaceId,
    );
    if (!item) {
      return yield* new ExtensionOperationError({
        operation: "install",
        message: `Extension ${input.itemId} was not found in marketplace ${input.marketplaceId}.`,
      });
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionOperationError({
            operation: "install",
            message: "Failed to read extension settings.",
            cause,
          }),
      ),
    );
    if (input.scope === "provider" && !input.providerInstanceId) {
      return yield* new ExtensionOperationError({
        operation: "install",
        message: "Provider-scoped installs require a provider instance.",
      });
    }
    const target: ExtensionInstallTarget =
      input.scope === "provider"
        ? { scope: "provider", providerInstanceId: input.providerInstanceId! }
        : { scope: "global" };
    const targetRoot = yield* installTargetRoot(input, settings);
    yield* materializeSkill(item, targetRoot);

    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const installed = [...settings.extensions.installed];
    const existingIndex = installed.findIndex((record) => record.id === item.id);
    if (existingIndex >= 0) {
      const existing = installed[existingIndex]!;
      const targets = existing.targets.some((candidate) => targetEquals(candidate, target))
        ? existing.targets
        : [...existing.targets, target];
      installed[existingIndex] = { ...existing, targets };
    } else {
      installed.push({
        id: item.id,
        marketplaceId: item.marketplaceId,
        type: item.type,
        name: item.name,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        ...(item.description ? { description: item.description } : {}),
        sourceUrl: item.sourceUrl,
        ...(item.sourceSubpath ? { sourceSubpath: item.sourceSubpath } : {}),
        compatibility: [...item.compatibility],
        targets: [target],
        installedAt: now,
      });
    }

    yield* serverSettings
      .updateSettings({
        extensions: { ...settings.extensions, installed },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ExtensionOperationError({
              operation: "install",
              message: "Failed to persist extension install state.",
              cause,
            }),
        ),
      );
    return yield* discoverAll();
  });

  const uninstall = Effect.fn("ExtensionMarketplace.uninstall")(function* (
    input: ExtensionUninstallInput,
  ): Effect.fn.Return<ExtensionDiscoveryResult, ExtensionOperationError> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionOperationError({
            operation: "uninstall",
            message: "Failed to read extension settings.",
            cause,
          }),
      ),
    );
    if (input.scope === "provider" && !input.providerInstanceId) {
      return yield* new ExtensionOperationError({
        operation: "uninstall",
        message: "Provider-scoped uninstalls require a provider instance.",
      });
    }
    const target: ExtensionInstallTarget =
      input.scope === "provider"
        ? { scope: "provider", providerInstanceId: input.providerInstanceId! }
        : { scope: "global" };
    const installed = settings.extensions.installed.flatMap((record) => {
      if (record.id !== input.itemId) return [record];
      const targets = record.targets.filter((candidate) => !targetEquals(candidate, target));
      return targets.length > 0 ? [{ ...record, targets }] : [];
    });
    yield* serverSettings
      .updateSettings({
        extensions: { ...settings.extensions, installed },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ExtensionOperationError({
              operation: "uninstall",
              message: "Failed to persist extension uninstall state.",
              cause,
            }),
        ),
      );
    return yield* discoverAll();
  });

  return {
    discover: discoverAll(),
    install,
    uninstall,
  };
}
