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
import { compareMaintenanceVersions, normalizeMaintenanceVersion } from "./version.ts";

export interface ProviderMaintenanceDefinitionInput {
  readonly provider: ProviderDriverKind;
  readonly packageName: string;
  readonly executableName: string;
  readonly homebrewFormula: string | null;
  readonly native: {
    readonly label: string;
    readonly updateArgs: ReadonlyArray<string>;
    readonly ownsPath: (normalizedPath: string) => boolean;
    readonly identityRoot?: (normalizedPath: string) => string | null;
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

function wrapperTargetPath(
  context: InstallationContext,
  wrapperPath: string,
  expression: string,
): string | null {
  const path = pathApi(context);
  const normalized = expression.replace(/^@/, "").replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  for (const marker of ["%~dp0", "%dp0%", "$basedir", "${basedir}"] as const) {
    if (lower.startsWith(marker.toLowerCase())) {
      return path.resolve(
        path.dirname(wrapperPath),
        normalized.slice(marker.length).replace(/^\/+/, ""),
      );
    }
  }
  if (normalized.includes("$") || normalized.includes("%")) return null;
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(path.dirname(wrapperPath), normalized);
}

function wrapperInvocationTargets(
  context: InstallationContext,
  wrapper: string | null,
  wrapperPath: string | null,
): ReadonlyArray<string> | null {
  if (!wrapper || !wrapperPath) return null;
  const isNodeLauncher = (token: string | undefined) => {
    const normalized = token?.replace(/^@/, "").replaceAll("\\", "/").toLowerCase();
    const executable = normalized?.split("/").at(-1);
    return normalized === "%_prog%" || executable === "node" || executable === "node.exe";
  };
  const invocationLines = wrapper.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("::") ||
      /^rem(?:\s|$)/i.test(trimmed)
    ) {
      return [];
    }
    const tokens = [...trimmed.matchAll(/"([^"]*)"|'([^']*)'|([^\s()"']+)/g)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? "",
    );
    const forwardedArgsIndex = tokens.findIndex((token) => token === "$@" || token === "%*");
    if (forwardedArgsIndex < 0) return [];
    const targetIndex = forwardedArgsIndex - 1;
    const target = tokens[targetIndex];
    const launcher = tokens[targetIndex - 1];
    const directLaunch =
      context.platform === "win32"
        ? targetIndex === 0 || launcher === "@"
        : launcher?.replace(/^@/, "").toLowerCase() === "exec";
    const nodeLaunch =
      isNodeLauncher(launcher) &&
      (context.platform === "win32" ||
        tokens[targetIndex - 2]?.replace(/^@/, "").toLowerCase() === "exec");
    return target && (directLaunch || nodeLaunch) ? [target] : [""];
  });
  if (invocationLines.length === 0) return null;
  const targets = invocationLines.map((expression) =>
    wrapperTargetPath(context, wrapperPath, expression),
  );
  return targets.every((target): target is string => target !== null) ? targets : null;
}

function packageRootFromWrapper(
  context: InstallationContext,
  wrapper: string | null,
  wrapperPath: string | null,
  packageName: string,
) {
  return Effect.gen(function* () {
    const targets = wrapperInvocationTargets(context, wrapper, wrapperPath);
    if (!targets) return null;
    const roots = yield* Effect.forEach(targets, (target) =>
      Effect.gen(function* () {
        const realTarget = yield* context.realPath(target);
        const lexicalRoot = packageRoot(target, packageName);
        const realTargetRoot = packageRoot(realTarget, packageName);
        const root = realTargetRoot ?? lexicalRoot;
        if (!root) return null;
        const realRoot = yield* context.realPath(root);
        return within(context, realTarget, realRoot) ? realRoot : null;
      }),
    );
    const verifiedRoots = roots.filter((root): root is string => root !== null);
    const first = verifiedRoots[0];
    return first &&
      verifiedRoots.length === roots.length &&
      verifiedRoots.every((root) => normalize(context, root) === normalize(context, first))
      ? first
      : null;
  });
}

function wrapperMentionsPackage(wrapper: string | null, packageName: string): boolean {
  if (!wrapper) return false;
  const normalized = wrapper.replaceAll("\\", "/").toLowerCase();
  const prefix = `/node_modules/${packageName.toLowerCase()}`;
  return normalized.includes(prefix);
}

const npmGlobalUpdateArgs = (packageName: string) => [
  "install",
  "-g",
  `--allow-scripts=${packageName}`,
  `${packageName}@latest`,
];

function npmGlobalPrefix(context: InstallationContext, packageRoot: string, packageName: string) {
  const slashRoot = packageRoot.replaceAll("\\", "/");
  const comparableRoot = context.platform === "win32" ? slashRoot.toLowerCase() : slashRoot;
  const marker = context.platform === "win32" ? "/node_modules/" : "/lib/node_modules/";
  const markerIndex = comparableRoot.indexOf(marker);
  if (markerIndex <= 0) return null;
  const packagePath = comparableRoot.slice(markerIndex + marker.length).replace(/\/+$/, "");
  const comparablePackageName =
    context.platform === "win32" ? packageName.toLowerCase() : packageName;
  return packagePath === comparablePackageName ? slashRoot.slice(0, markerIndex) : null;
}

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
  readonly executable: string;
  readonly updateRoot: string;
  readonly currentVersion: string | null;
}

function detectNodePackage(input: ProviderMaintenanceDefinitionInput, manager: NodeManager) {
  return Effect.fn(`detect-${manager.id}`)(function* (context: InstallationContext) {
    const observed = normalize(
      context,
      context.realCommandPath ?? context.resolvedCommandPath ?? context.binaryPath,
    );
    const wrapper = yield* context.readTextFile(context.resolvedCommandPath ?? "");
    const wrapperRoot = yield* packageRootFromWrapper(
      context,
      wrapper,
      context.resolvedCommandPath,
      input.packageName,
    );
    let root = packageRoot(observed, input.packageName) ?? wrapperRoot;
    if (!root && wrapperMentionsPackage(wrapper, input.packageName)) {
      return undetermined;
    }
    if (!root && manager.id !== "bun") return notMatched;
    const executable = yield* context.resolveCommand(manager.command);
    if (!executable) {
      return root ? undetermined : notMatched;
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
    if (text(manifest?.name) !== input.packageName) return undetermined;
    let updateRoot = resolvedManagerRoot;
    if (manager.id === "npm") {
      const prefix = npmGlobalPrefix(context, root, input.packageName);
      if (!prefix) {
        return undetermined;
      }
      if (
        context.platform === "win32" &&
        !within(context, root, ownershipRoot) &&
        (!context.resolvedCommandPath ||
          normalize(context, pathApi(context).dirname(context.resolvedCommandPath)) !==
            normalize(context, prefix))
      ) {
        return undetermined;
      }
      updateRoot = prefix;
    } else if (!within(context, root, ownershipRoot)) {
      return notMatched;
    }
    return matched({
      executable,
      updateRoot,
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
      manager.latestArgs(input.packageName),
      context.environment,
    );
    const updateArgs =
      manager.id === "npm"
        ? [
            ...npmGlobalUpdateArgs(input.packageName).slice(0, 2),
            "--prefix",
            evidence.updateRoot,
            ...npmGlobalUpdateArgs(input.packageName).slice(2),
          ]
        : manager.updateArgs(input.packageName);
    return resolved(input, context, {
      kind: manager.id,
      label: `Managed by ${manager.label}`,
      root: evidence.updateRoot,
      executable: evidence.executable,
      currentVersion: evidence.currentVersion,
      latestVersion: normalizeMaintenanceVersion(output(latest?.stdout)),
      args: updateArgs,
      displayCommand: `${manager.command} ${updateArgs.join(" ")}`,
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
    ownershipVerified: true,
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
          root:
            native.identityRoot?.(normalize(context, executable)) ??
            pathApi(context).dirname(executable),
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

function isHomebrewShimPath(path: string) {
  return (
    path.startsWith("/opt/homebrew/bin/") ||
    path.startsWith("/usr/local/bin/") ||
    path.includes("/.linuxbrew/bin/")
  );
}

function homebrewPackageFromPath(path: string): string | null {
  const lower = path.toLowerCase();
  const marker = ["/cellar/", "/caskroom/"].find((candidate) => lower.includes(candidate));
  if (!marker) return null;
  const start = lower.indexOf(marker) + marker.length;
  return path.slice(start).split("/")[0] || null;
}

function normalizeHomebrewCaskVersion(value: string | null): string | null {
  // Homebrew appends cask build/revision data after a comma; provider
  // version precedence is determined by the version before it.
  return normalizeMaintenanceVersion(value?.split(",", 1)[0]);
}

function homebrewDefinition(input: ProviderMaintenanceDefinitionInput) {
  if (!input.homebrewFormula) return null;
  const configuredFormula = input.homebrewFormula;
  return defineInstallation<{
    executable: string;
    formula: string;
    packageType: "formula" | "cask";
    prefix: string;
    currentVersion: string | null;
    latestVersion: string | null;
  }>({
    id: `${input.provider}-homebrew`,
    detect: Effect.fn("detect-homebrew")(function* (context) {
      const observed = normalize(context, context.realCommandPath ?? context.binaryPath);
      const observedLower = observed.toLowerCase();
      if (!observedLower.includes("/cellar/") && !observedLower.includes("/caskroom/")) {
        return isHomebrewShimPath(observedLower) ? undetermined : notMatched;
      }
      const executable = yield* context.resolveCommand("brew");
      if (!executable) return undetermined;
      const pathPackage = homebrewPackageFromPath(observed);
      const configuredBaseName = configuredFormula.split("/").at(-1);
      const configuredMatchesPath =
        pathPackage !== null && configuredBaseName?.toLowerCase() === pathPackage.toLowerCase();
      const candidates = [
        ...new Set(
          [configuredMatchesPath ? configuredFormula : null, pathPackage, configuredFormula].filter(
            (candidate): candidate is string => candidate !== null,
          ),
        ),
      ];
      const ownershipCandidates = yield* Effect.forEach(candidates, (formula) =>
        Effect.gen(function* () {
          const formulaPrefixProbe = yield* context.run(
            executable,
            ["--prefix", "--installed", formula],
            context.environment,
          );
          const formulaPrefix = output(formulaPrefixProbe?.stdout);
          const realFormulaPrefix = formulaPrefix ? yield* context.realPath(formulaPrefix) : null;
          if (
            formulaPrefixProbe?.exitCode === 0 &&
            realFormulaPrefix &&
            within(context, observed, realFormulaPrefix)
          ) {
            return { formula, packageType: "formula" as const, prefix: realFormulaPrefix };
          }
          const caskPrefixProbe = yield* context.run(
            executable,
            ["--caskroom", formula],
            context.environment,
          );
          const caskPrefix = output(caskPrefixProbe?.stdout);
          const realCaskPrefix = caskPrefix ? yield* context.realPath(caskPrefix) : null;
          return caskPrefixProbe?.exitCode === 0 &&
            realCaskPrefix &&
            within(context, observed, realCaskPrefix)
            ? { formula, packageType: "cask" as const, prefix: realCaskPrefix }
            : null;
        }),
      );
      const ownership = ownershipCandidates.find(
        (
          candidate,
        ): candidate is {
          readonly formula: string;
          readonly packageType: "formula" | "cask";
          readonly prefix: string;
        } => candidate !== null,
      );
      if (!ownership) return undetermined;
      const { formula, packageType, prefix } = ownership;
      const infoProbe = yield* context.run(
        executable,
        ["info", "--json=v2", formula],
        context.environment,
      );
      const info = json(infoProbe?.stdout ?? null);
      if (!infoProbe || infoProbe.exitCode !== 0 || !info) {
        return undetermined;
      }
      const formulaInfo = records(info.formulae)[0];
      const caskInfo = records(info.casks)[0];
      const versions = formulaInfo?.versions;
      const stable =
        typeof versions === "object" && versions !== null && !Array.isArray(versions)
          ? text((versions as Record<string, unknown>).stable)
          : null;
      const installedFormula = records(formulaInfo?.installed)[0];
      const installedCask = Array.isArray(caskInfo?.installed)
        ? text(caskInfo.installed[0])
        : text(caskInfo?.installed);
      const currentVersion = normalizeMaintenanceVersion(
        packageType === "formula" ? text(installedFormula?.version) : null,
      );
      const normalizedCurrentVersion =
        packageType === "formula" ? currentVersion : normalizeHomebrewCaskVersion(installedCask);
      if (!normalizedCurrentVersion) return undetermined;
      return matched({
        executable,
        formula,
        packageType,
        prefix,
        currentVersion: normalizedCurrentVersion,
        latestVersion:
          packageType === "formula"
            ? normalizeMaintenanceVersion(stable)
            : normalizeHomebrewCaskVersion(text(caskInfo?.version)),
      });
    }),
    resolve: (evidence, context) => {
      const formula = evidence.formula;
      const args =
        evidence.packageType === "cask"
          ? (["upgrade", "--cask", formula] as const)
          : (["upgrade", formula] as const);
      return Effect.succeed(
        resolved(input, context, {
          kind: "homebrew",
          label: "Managed by Homebrew",
          root: stableHomebrewRoot(context, evidence.prefix),
          executable: evidence.executable,
          currentVersion: evidence.currentVersion,
          latestVersion: evidence.latestVersion,
          args,
          displayCommand: `brew ${args.join(" ")}`,
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
      const resolvedCommandPath = context.resolvedCommandPath.replaceAll("\\", "/");
      const observed = resolvedCommandPath.toLowerCase();
      const marker = "/shims/";
      const index = observed.lastIndexOf(marker);
      if (index < 0) return notMatched;
      const root = resolvedCommandPath.slice(0, index);
      const shim = context.resolvedCommandPath.replace(/\.(?:exe|cmd|ps1)$/i, "") + ".shim";
      const target = (yield* context.readTextFile(shim))?.match(/^path\s*=\s*"([^"]+)"/m)?.[1];
      const targetPath = target ? normalize(context, target) : null;
      const app = targetPath?.match(/\/apps\/([^/]+)\/current(?:\/|$)/)?.[1];
      if (
        !target ||
        !app ||
        !within(context, target, pathApi(context).join(root, "apps", app, "current"))
      ) {
        return undetermined;
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
      if (!install || !manifest) return undetermined;
      const bucket = text(install.bucket);
      if (!bucket) return undetermined;
      const executable = yield* context.resolveCommand("scoop");
      if (!executable) return undetermined;
      const slashExecutable = executable.replaceAll("\\", "/");
      const executablePath = slashExecutable.toLowerCase();
      const managerMarker = "/shims/";
      const managerIndex = executablePath.lastIndexOf(managerMarker);
      if (managerIndex < 0) return undetermined;
      const managerRoot = slashExecutable.slice(0, managerIndex);
      const global = !within(context, executable, root);
      if (global) {
        const environmentRoot = text(context.environment.SCOOP_GLOBAL);
        const configProbe = environmentRoot
          ? null
          : yield* context.run(executable, ["config", "global_path"], context.environment);
        const configOutput = output(configProbe?.stdout);
        const configuredRoot =
          configProbe?.exitCode === 0 && configOutput && pathApi(context).isAbsolute(configOutput)
            ? configOutput
            : null;
        const defaultRoot = pathApi(context).join(
          context.environment.ProgramData ?? "C:\\ProgramData",
          "scoop",
        );
        const effectiveGlobalRoot = environmentRoot ?? configuredRoot ?? defaultRoot;
        if (normalize(context, effectiveGlobalRoot) !== normalize(context, root)) {
          return undetermined;
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
        return undetermined;
      }
      const keys = searches.flatMap((search, searchIndex) =>
        (searchResults[searchIndex]?.stdout.match(/^HKEY_[^\r\n]+/gim) ?? []).map((key) => ({
          key: key.trim(),
          scope: search.scope,
          view: search.view,
        })),
      );
      if (keys.length === 0) return undetermined;
      const entryResults = yield* Effect.forEach(keys, ({ key, view }) =>
        context.run(reg, ["query", key, view], context.environment),
      );
      if (entryResults.some((result) => result === null || result.exitCode !== 0)) {
        return undetermined;
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
      if (matches.length === 0) return undetermined;
      if (matches.length !== 1 || !matches[0]!.entry.sourceId) return undetermined;
      const executable = yield* context.resolveCommand("winget");
      if (!executable) return undetermined;
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
        return undetermined;
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
          ? (show.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) ?? [])
              .map(normalizeMaintenanceVersion)
              .filter((value): value is string => value !== null)
              .reduce<string | null>(
                (maximum, value) =>
                  maximum === null || compareMaintenanceVersions(value, maximum) === 1
                    ? value
                    : maximum,
                null,
              )
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
  };
}
