// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  canonicalPath,
  defineInstallation,
  installationIdentity,
  matched,
  notMatched,
  type InstallationCatalog,
  type InstallationContext,
  type ResolvedInstallation,
  undetermined,
} from "./definition.ts";
import { normalizeMaintenanceVersion } from "./version.ts";

export interface ProviderMaintenanceDefinitionInput {
  readonly provider: ProviderDriverKind;
  readonly packageName: string;
  readonly executableName: string;
  readonly homebrewFormula: string | null;
  readonly native: {
    readonly label: string;
    readonly updateArgs: ReadonlyArray<string>;
    readonly ownsPath: (normalizedPath: string) => boolean;
    readonly environment?: (
      executable: string,
      environment: NodeJS.ProcessEnv,
    ) => NodeJS.ProcessEnv;
  } | null;
  readonly instructionsUrl: string;
  readonly wingetPackageId?: string;
}

function normalize(context: InstallationContext, path: string): string {
  return canonicalPath(path, context.platform);
}

function pathApi(context: InstallationContext) {
  return context.platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function within(context: InstallationContext, child: string, parent: string): boolean {
  const root = normalize(context, parent).replace(/\/$/, "");
  const path = normalize(context, child);
  return path === root || path.startsWith(`${root}/`);
}

function json(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function records(value: unknown): ReadonlyArray<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function output(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed.trim() || null : trimmed;
  } catch {
    return trimmed;
  }
}

function packageRoot(path: string, packageName: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const needle = `/node_modules/${packageName}/`;
  const index = normalized.toLowerCase().lastIndexOf(needle.toLowerCase());
  return index < 0 ? null : normalized.slice(0, index + needle.length - 1);
}

function packageRootFromWrapper(
  context: InstallationContext,
  wrapper: string | null,
  wrapperPath: string | null,
  packageName: string,
): string | null {
  if (!wrapper || !wrapperPath) return null;
  const path = pathApi(context);
  const embedded = packageRoot(wrapper, packageName);
  if (embedded && path.isAbsolute(embedded)) return embedded;
  const normalized = wrapper.replaceAll("\\", "/");
  const packageSuffix = `/node_modules/${packageName}/`;
  const suffixIndex = normalized.toLowerCase().lastIndexOf(packageSuffix.toLowerCase());
  if (suffixIndex < 0) {
    return null;
  }
  const prefix = normalized.slice(0, suffixIndex);
  const lowerPrefix = prefix.toLowerCase();
  const windowsMarkers = ["%~dp0", "%dp0%"] as const;
  const windowsMarker = windowsMarkers
    .map((marker) => ({ marker, index: lowerPrefix.lastIndexOf(marker) }))
    .sort((left, right) => right.index - left.index)[0];
  const windowsBaseIndex = windowsMarker?.index ?? -1;
  if (windowsBaseIndex >= 0) {
    return path.resolve(
      path.dirname(wrapperPath),
      prefix.slice(windowsBaseIndex + (windowsMarker?.marker.length ?? 0)).replace(/^\/+/, ""),
      "node_modules",
      ...packageName.split("/"),
    );
  }
  const shellBaseIndex = prefix.lastIndexOf("$basedir");
  if (shellBaseIndex >= 0) {
    return path.resolve(
      path.dirname(wrapperPath),
      prefix.slice(shellBaseIndex + "$basedir".length).replace(/^\/+/, ""),
      "node_modules",
      ...packageName.split("/"),
    );
  }
  return path.join(path.dirname(wrapperPath), "node_modules", ...packageName.split("/"));
}

function wrapperHasAmbiguousPackagePrefix(wrapper: string | null, packageName: string): boolean {
  if (!wrapper) return false;
  const normalized = wrapper.replaceAll("\\", "/").toLowerCase();
  const prefix = `/node_modules/${packageName.toLowerCase()}`;
  return normalized.includes(prefix) && !normalized.includes(`${prefix}/`);
}

const npmGlobalUpdateArgs = (packageName: string) => [
  "install",
  "-g",
  `--allow-scripts=${packageName}`,
  `${packageName}@latest`,
];

const nodeManagers = [
  {
    id: "vite-plus",
    label: "Vite+",
    command: "vp",
    rootArgs: ["root", "-g"],
    latestArgs: (name: string) => ["view", `${name}@latest`, "version", "--json"],
    updateArgs: (name: string) => ["i", "-g", name],
  },
  {
    id: "bun",
    label: "Bun",
    command: "bun",
    rootArgs: ["pm", "bin", "-g"],
    latestArgs: (name: string) => ["pm", "view", name, "version"],
    updateArgs: (name: string) => ["install", "-g", `${name}@latest`],
  },
  {
    id: "pnpm",
    label: "pnpm",
    command: "pnpm",
    rootArgs: ["root", "-g"],
    latestArgs: (name: string) => ["view", `${name}@latest`, "version", "--json"],
    updateArgs: (name: string) => ["add", "-g", `${name}@latest`],
  },
  {
    id: "npm",
    label: "npm",
    command: "npm",
    rootArgs: ["root", "-g"],
    latestArgs: (name: string) => ["view", `${name}@latest`, "version", "--json"],
    updateArgs: npmGlobalUpdateArgs,
  },
] as const;

type NodeManager = (typeof nodeManagers)[number];
interface NodeEvidence {
  readonly manager: NodeManager;
  readonly executable: string;
  readonly root: string;
  readonly currentVersion: string | null;
}

function detectNodePackage(input: ProviderMaintenanceDefinitionInput, manager: NodeManager) {
  return Effect.fn(`detect-${manager.id}`)(function* (context: InstallationContext) {
    const observed = normalize(
      context,
      context.realCommandPath ?? context.resolvedCommandPath ?? context.binaryPath,
    );
    const wrapper = yield* context.readTextFile(context.resolvedCommandPath ?? "");
    let root =
      packageRoot(observed, input.packageName) ??
      packageRootFromWrapper(context, wrapper, context.resolvedCommandPath, input.packageName);
    if (!root && wrapperHasAmbiguousPackagePrefix(wrapper, input.packageName)) {
      return undetermined("The command wrapper's package ownership is ambiguous.");
    }
    if (!root && manager.id !== "bun") return notMatched;
    const executable = yield* context.resolveCommand(manager.command);
    if (!executable) {
      return root ? undetermined("The owning package manager is unavailable.") : notMatched;
    }
    const rootProbe = yield* context.run(executable, manager.rootArgs, context.environment);
    const managerRoot = output(rootProbe?.stdout);
    if (!rootProbe || rootProbe.exitCode !== 0 || !managerRoot) {
      return notMatched;
    }
    const resolvedManagerRoot = yield* context.realPath(managerRoot);
    const ownershipRoot =
      manager.id === "bun" ? pathApi(context).dirname(resolvedManagerRoot) : resolvedManagerRoot;
    root ??=
      manager.id === "bun" && within(context, observed, managerRoot)
        ? pathApi(context).join(
            ownershipRoot,
            "install",
            "global",
            "node_modules",
            input.packageName,
          )
        : null;
    if (!root) return notMatched;
    root = yield* context.realPath(root);
    const manifest = json(yield* context.readTextFile(pathApi(context).join(root, "package.json")));
    if (text(manifest?.name) !== input.packageName) return notMatched;
    if (!within(context, root, ownershipRoot)) return notMatched;
    return matched({
      manager,
      executable,
      root: resolvedManagerRoot,
      currentVersion: normalizeMaintenanceVersion(text(manifest?.version)),
    });
  });
}

function resolveNodePackage(input: ProviderMaintenanceDefinitionInput, manager: NodeManager) {
  return Effect.fn(`resolve-${manager.id}`)(function* (
    evidence: NodeEvidence,
    context: InstallationContext,
  ) {
    const latest = yield* context.run(
      evidence.executable,
      evidence.manager.latestArgs(input.packageName),
      context.environment,
    );
    const updateArgs = evidence.manager.updateArgs(input.packageName);
    return resolved(input, context, {
      kind: evidence.manager.id,
      label: `Managed by ${evidence.manager.label}`,
      root: evidence.root,
      executable: evidence.executable,
      currentVersion: evidence.currentVersion,
      latestVersion: normalizeMaintenanceVersion(output(latest?.stdout)),
      args: updateArgs,
      displayCommand: `${evidence.manager.command} ${updateArgs.join(" ")}`,
    });
  });
}

function resolved(
  input: ProviderMaintenanceDefinitionInput,
  context: InstallationContext,
  value: {
    readonly kind: string;
    readonly label: string;
    readonly root: string;
    readonly executable: string;
    readonly currentVersion: string | null;
    readonly latestVersion: string | null;
    readonly args: ReadonlyArray<string>;
    readonly displayCommand: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly ownershipVerified?: boolean;
    readonly identityQualifier?: string;
    readonly identityExecutable?: string;
  },
): ResolvedInstallation {
  return {
    identityKey: installationIdentity({
      definition: `${input.provider}-${value.kind}`,
      executable: normalize(context, value.identityExecutable ?? value.executable),
      package: input.packageName,
      qualifier: value.identityQualifier ?? null,
      root: normalize(context, value.root),
    }),
    lockKey: `${value.kind}:${normalize(context, value.root)}`,
    label: value.label,
    ownershipVerified: value.ownershipVerified ?? true,
    packageName: input.packageName,
    currentVersion: value.currentVersion,
    latestVersion: value.latestVersion,
    update: {
      executable: value.executable,
      args: value.args,
      environment: value.environment ?? context.environment,
      displayCommand: value.displayCommand,
    },
    instructionsUrl: input.instructionsUrl,
  };
}

function nativeDefinition(input: ProviderMaintenanceDefinitionInput) {
  if (!input.native) return null;
  const native = input.native;
  return defineInstallation<string>({
    id: `${input.provider}-native`,
    detect: (context) => {
      const executable = context.realCommandPath ?? context.resolvedCommandPath;
      return Effect.succeed(
        executable && native.ownsPath(normalize(context, executable))
          ? matched(executable)
          : notMatched,
      );
    },
    resolve: (executable, context) =>
      Effect.succeed(
        resolved(input, context, {
          kind: "native",
          label: native.label,
          root: pathApi(context).dirname(executable),
          executable,
          identityExecutable: context.resolvedCommandPath ?? executable,
          currentVersion: null,
          latestVersion: null,
          args: native.updateArgs,
          ...(native.environment
            ? { environment: native.environment(executable, context.environment) }
            : {}),
          displayCommand: `${input.executableName} ${native.updateArgs.join(" ")}`,
        }),
      ),
  });
}

function stableHomebrewRoot(context: InstallationContext, prefix: string): string {
  const normalized = normalize(context, prefix);
  const lower = normalized.toLowerCase();
  const marker = ["/cellar/", "/caskroom/"].find((candidate) => lower.includes(candidate));
  if (!marker) return normalized;
  const markerIndex = lower.indexOf(marker);
  const formulaStart = markerIndex + marker.length;
  const formulaEnd = normalized.indexOf("/", formulaStart);
  return formulaEnd < 0 ? normalized : normalized.slice(0, formulaEnd);
}

function homebrewDefinition(input: ProviderMaintenanceDefinitionInput) {
  return defineInstallation<{
    executable: string;
    prefix: string;
    currentVersion: string | null;
    latestVersion: string | null;
  }>({
    id: `${input.provider}-homebrew`,
    detect: Effect.fn("detect-homebrew")(function* (context) {
      if (!input.homebrewFormula) return notMatched;
      const observed = normalize(context, context.realCommandPath ?? context.binaryPath);
      const observedLower = observed.toLowerCase();
      if (!observedLower.includes("/cellar/") && !observedLower.includes("/caskroom/")) {
        return notMatched;
      }
      const executable = yield* context.resolveCommand("brew");
      if (!executable) return undetermined("Homebrew executable is unavailable.");
      const formula = input.homebrewFormula;
      const formulaPrefixProbe = yield* context.run(
        executable,
        ["--prefix", "--installed", formula],
        context.environment,
      );
      const formulaPrefix = output(formulaPrefixProbe?.stdout);
      const caskPrefixProbe = yield* context.run(
        executable,
        ["--caskroom", formula],
        context.environment,
      );
      const caskPrefix = output(caskPrefixProbe?.stdout);
      const prefix =
        formulaPrefixProbe?.exitCode === 0 &&
        formulaPrefix &&
        within(context, observed, formulaPrefix)
          ? formulaPrefix
          : caskPrefixProbe?.exitCode === 0 && caskPrefix && within(context, observed, caskPrefix)
            ? caskPrefix
            : null;
      if (!prefix) return undetermined("Homebrew formula ownership could not be verified.");
      const infoProbe = yield* context.run(
        executable,
        ["info", "--json=v2", formula],
        context.environment,
      );
      const info = json(infoProbe?.stdout ?? null);
      if (!infoProbe || infoProbe.exitCode !== 0 || !info) {
        return undetermined("Homebrew formula metadata is unavailable.");
      }
      const formulaInfo = records(info.formulae)[0];
      const caskInfo = records(info.casks)[0];
      const versions = formulaInfo?.versions;
      const stable =
        typeof versions === "object" && versions !== null && !Array.isArray(versions)
          ? text((versions as Record<string, unknown>).stable)
          : null;
      const installedFormula = records(formulaInfo?.installed)[0];
      const installedCask = Array.isArray(caskInfo?.installed) ? text(caskInfo.installed[0]) : null;
      const currentVersion = normalizeMaintenanceVersion(
        text(installedFormula?.version) ?? installedCask,
      );
      if (!currentVersion) return undetermined("Homebrew installed version is unavailable.");
      return matched({
        executable,
        prefix,
        currentVersion,
        latestVersion: normalizeMaintenanceVersion(stable ?? text(caskInfo?.version)),
      });
    }),
    resolve: (evidence, context) => {
      const formula = input.homebrewFormula!;
      return Effect.succeed(
        resolved(input, context, {
          kind: "homebrew",
          label: "Managed by Homebrew",
          root: stableHomebrewRoot(context, evidence.prefix),
          executable: evidence.executable,
          currentVersion: evidence.currentVersion,
          latestVersion: evidence.latestVersion,
          args: ["upgrade", formula],
          displayCommand: `brew upgrade ${formula}`,
        }),
      );
    },
  });
}

function scoopDefinition(input: ProviderMaintenanceDefinitionInput) {
  return defineInstallation<{
    root: string;
    executable: string;
    app: string;
    bucket: string;
    global: boolean;
    current: string | null;
    latest: string | null;
  }>({
    id: `${input.provider}-scoop`,
    detect: Effect.fn("detect-scoop")(function* (context) {
      if (context.platform !== "win32" || !context.resolvedCommandPath) return notMatched;
      const observed = normalize(context, context.resolvedCommandPath);
      const marker = "/shims/";
      const index = observed.lastIndexOf(marker);
      if (index < 0) return notMatched;
      const root = context.resolvedCommandPath.replaceAll("\\", "/").slice(0, index);
      const shim = context.resolvedCommandPath.replace(/\.(?:exe|cmd|ps1)$/i, "") + ".shim";
      const target = (yield* context.readTextFile(shim))?.match(/^path\s*=\s*"([^"]+)"/m)?.[1];
      const targetPath = target ? normalize(context, target) : null;
      const app = targetPath?.match(/\/apps\/([^/]+)\/current(?:\/|$)/)?.[1];
      if (
        !target ||
        !app ||
        !within(context, target, pathApi(context).join(root, "apps", app, "current"))
      ) {
        return undetermined("Scoop shim ownership metadata is unreadable.");
      }
      const install = json(
        yield* context.readTextFile(
          pathApi(context).join(root, "apps", app, "current", "install.json"),
        ),
      );
      const manifest = json(
        yield* context.readTextFile(
          pathApi(context).join(root, "apps", app, "current", "manifest.json"),
        ),
      );
      if (!install || !manifest) return undetermined("Scoop metadata is unreadable.");
      const bucket = text(install.bucket);
      if (!bucket) return undetermined("Scoop bucket provenance is unavailable.");
      const executable = yield* context.resolveCommand("scoop");
      if (!executable) return undetermined("Scoop is unavailable.");
      const executablePath = normalize(context, executable);
      const managerMarker = "/shims/";
      const managerIndex = executablePath.lastIndexOf(managerMarker);
      if (managerIndex < 0) return undetermined("The owning Scoop root is unavailable.");
      const managerRoot = executable.replaceAll("\\", "/").slice(0, managerIndex);
      let global = !within(context, executable, root);
      if (global) {
        const globalProbe = yield* context.run(
          executable,
          ["config", "SCOOP_GLOBAL"],
          context.environment,
        );
        const globalRoot = output(globalProbe?.stdout);
        if (
          !globalProbe ||
          globalProbe.exitCode !== 0 ||
          !globalRoot ||
          normalize(context, globalRoot) !== normalize(context, root)
        ) {
          return undetermined("The global Scoop root owning this shim could not be verified.");
        }
      }
      const available = json(
        yield* context.readTextFile(
          pathApi(context).join(managerRoot, "buckets", bucket, "bucket", `${app}.json`),
        ),
      );
      return matched({
        root,
        executable,
        app,
        bucket,
        global,
        current: normalizeMaintenanceVersion(text(manifest.version)),
        latest: normalizeMaintenanceVersion(text(available?.version)),
      });
    }),
    resolve: (evidence, context) =>
      Effect.succeed(
        resolved(input, context, {
          kind: "scoop",
          label: "Managed by Scoop",
          root: evidence.root,
          executable: evidence.executable,
          currentVersion: evidence.current,
          latestVersion: evidence.latest,
          args: [
            "update",
            `${evidence.bucket}/${evidence.app}`,
            ...(evidence.global ? ["--global"] : []),
          ],
          displayCommand: `scoop update ${evidence.bucket}/${evidence.app}${evidence.global ? " --global" : ""}`,
          identityQualifier: `${evidence.bucket}/${evidence.app}/${evidence.global ? "global" : "user"}`,
        }),
      ),
  });
}

interface ArpEntry {
  readonly displayVersion: string | null;
  readonly packageId: string | null;
  readonly sourceId: string | null;
  readonly symlinkPath: string | null;
  readonly targetPath: string | null;
}

export function parseWingetPortableArp(outputText: string): ReadonlyArray<ArpEntry> {
  const entries: Array<ArpEntry> = [];
  let values = new Map<string, string>();
  const flush = () => {
    const packageId = values.get("WinGetPackageIdentifier") ?? null;
    if (packageId) {
      entries.push({
        packageId,
        displayVersion: values.get("DisplayVersion") ?? null,
        sourceId: values.get("WinGetSourceIdentifier") ?? null,
        symlinkPath: values.get("SymlinkFullPath") ?? null,
        targetPath: values.get("TargetFullPath") ?? null,
      });
    }
    values = new Map();
  };
  for (const line of outputText.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) flush();
    const match = line.match(/^\s*([^\s].*?)\s+REG_\w+\s+(.*?)\s*$/);
    if (match) values.set(match[1]!, match[2]!);
  }
  flush();
  return entries;
}

export function parseWingetSources(outputText: string): ReadonlyArray<{
  readonly data: string | null;
  readonly identifier: string;
  readonly name: string;
}> {
  return outputText.split(/\r?\n/).flatMap((line) => {
    const source = json(line);
    const identifier = text(source?.Identifier);
    const name = text(source?.Name);
    return identifier && name ? [{ data: text(source?.Data), identifier, name }] : [];
  });
}

function wingetDefinition(input: ProviderMaintenanceDefinitionInput) {
  if (!input.wingetPackageId) return null;
  const packageId = input.wingetPackageId;
  return defineInstallation<{
    executable: string;
    source: string;
    sourceIdentifier: string;
    scope: "machine" | "user";
    current: string | null;
  }>({
    id: `${input.provider}-winget`,
    detect: Effect.fn("detect-winget")(function* (context) {
      if (context.platform !== "win32") return notMatched;
      const observed = normalize(context, context.resolvedCommandPath ?? context.binaryPath);
      const real = normalize(context, context.realCommandPath ?? observed);
      if (!observed.includes("/microsoft/winget/") && !real.includes("/microsoft/winget/"))
        return notMatched;
      const reg = pathApi(context).join(
        context.environment.SystemRoot ?? "C:\\Windows",
        "System32",
        "reg.exe",
      );
      const root = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
      const searches = [
        { root: `HKCU\\${root}`, scope: "user", view: "/reg:64" },
        { root: `HKLM\\${root}`, scope: "machine", view: "/reg:64" },
        { root: `HKLM\\${root}`, scope: "machine", view: "/reg:32" },
      ] as const;
      const searchResults = yield* Effect.forEach(searches, (search) =>
        context.run(
          reg,
          ["query", search.root, "/s", "/f", packageId, "/d", "/e", search.view],
          context.environment,
        ),
      );
      if (
        searchResults.some(
          (result) => result === null || (result.exitCode !== 0 && result.exitCode !== 1),
        )
      ) {
        return undetermined("WinGet ARP metadata is unreadable.");
      }
      const keys = searches.flatMap((search, searchIndex) =>
        (searchResults[searchIndex]?.stdout.match(/^HKEY_[^\r\n]+/gim) ?? []).map((key) => ({
          key: key.trim(),
          scope: search.scope,
          view: search.view,
        })),
      );
      if (keys.length === 0) return undetermined("WinGet package metadata is unavailable.");
      const entryResults = yield* Effect.forEach(keys, ({ key, view }) =>
        context.run(reg, ["query", key, view], context.environment),
      );
      if (entryResults.some((result) => result === null || result.exitCode !== 0)) {
        return undetermined("WinGet package metadata could not be read.");
      }
      const matches = entryResults
        .flatMap((result, resultIndex) =>
          parseWingetPortableArp(result?.stdout ?? "").map((entry) => ({
            entry,
            scope: keys[resultIndex]!.scope,
          })),
        )
        .filter(
          ({ entry }) =>
            entry.packageId === packageId &&
            ((entry.symlinkPath && normalize(context, entry.symlinkPath) === observed) ||
              (entry.targetPath && normalize(context, entry.targetPath) === real)),
        );
      if (matches.length === 0)
        return undetermined("WinGet executable ownership could not be verified.");
      if (matches.length !== 1 || !matches[0]!.entry.sourceId)
        return undetermined("WinGet ownership is ambiguous.");
      const executable = yield* context.resolveCommand("winget");
      if (!executable) return undetermined("WinGet is unavailable.");
      const sourceProbe = yield* context.run(
        executable,
        ["source", "export", "--disable-interactivity"],
        context.environment,
      );
      const source = parseWingetSources(sourceProbe?.stdout ?? "").find(
        (candidate) =>
          candidate.identifier === matches[0]!.entry.sourceId ||
          candidate.data === matches[0]!.entry.sourceId ||
          candidate.name === matches[0]!.entry.sourceId,
      )?.name;
      if (!sourceProbe || sourceProbe.exitCode !== 0 || !source) {
        return undetermined("The WinGet source owning this package is unavailable.");
      }
      return matched({
        executable,
        source,
        sourceIdentifier: matches[0]!.entry.sourceId!,
        scope: matches[0]!.scope,
        current: normalizeMaintenanceVersion(matches[0]!.entry.displayVersion),
      });
    }),
    resolve: Effect.fn("resolve-winget")(function* (evidence, context) {
      const show = yield* context.run(
        evidence.executable,
        [
          "show",
          "--id",
          packageId,
          "--exact",
          "--source",
          evidence.source,
          "--versions",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
        context.environment,
      );
      const latest =
        show && show.exitCode === 0
          ? ((show.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) ?? [])
              .map(normalizeMaintenanceVersion)
              .find((value): value is string => value !== null) ?? null)
          : null;
      return resolved(input, context, {
        kind: "winget",
        label: "Managed by WinGet",
        root: pathApi(context).dirname(evidence.executable),
        executable: evidence.executable,
        currentVersion: evidence.current,
        latestVersion: latest,
        args: [
          "upgrade",
          "--id",
          packageId,
          "--exact",
          "--source",
          evidence.source,
          "--scope",
          evidence.scope,
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
        displayCommand: `winget upgrade --id ${packageId} --exact --source ${evidence.source} --scope ${evidence.scope}`,
        identityQualifier: `${evidence.sourceIdentifier}/${evidence.source}/${packageId}/${evidence.scope}`,
      });
    }),
  });
}

function legacyFallback(input: ProviderMaintenanceDefinitionInput) {
  return defineInstallation<{ executable: string; root: string }>({
    id: `${input.provider}-unknown`,
    detect: Effect.fn("detect-legacy-npm")(function* (context) {
      if (!context.isBareCommand) return notMatched;
      const executable = yield* context.resolveCommand("npm");
      if (!executable) return notMatched;
      const probe = yield* context.run(executable, ["root", "-g"], context.environment);
      const root = output(probe?.stdout);
      return probe?.exitCode === 0 && root
        ? matched({ executable, root })
        : undetermined("Legacy npm target is unavailable.");
    }),
    resolve: Effect.fn("resolve-legacy-npm")(function* (evidence, context) {
      const latest = yield* context.run(
        evidence.executable,
        ["view", `${input.packageName}@latest`, "version", "--json"],
        context.environment,
      );
      return resolved(input, context, {
        kind: "unknown",
        label: "Unknown installation — legacy npm fallback",
        root: evidence.root,
        executable: evidence.executable,
        currentVersion: null,
        latestVersion: normalizeMaintenanceVersion(output(latest?.stdout)),
        args: npmGlobalUpdateArgs(input.packageName),
        displayCommand: `npm install -g --allow-scripts=${input.packageName} ${input.packageName}@latest`,
        ownershipVerified: false,
      });
    }),
  });
}

export function makeProviderInstallationCatalog(
  input: ProviderMaintenanceDefinitionInput,
): InstallationCatalog {
  return {
    installations: [
      nativeDefinition(input),
      homebrewDefinition(input),
      scoopDefinition(input),
      wingetDefinition(input),
      ...nodeManagers.map((manager) =>
        defineInstallation<NodeEvidence>({
          id: `${input.provider}-${manager.id}`,
          detect: detectNodePackage(input, manager),
          resolve: resolveNodePackage(input, manager),
        }),
      ),
    ].filter((definition): definition is NonNullable<typeof definition> => definition !== null),
    fallbacks: [legacyFallback(input)],
  };
}
