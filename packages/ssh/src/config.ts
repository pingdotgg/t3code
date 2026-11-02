import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { SshHostDiscoveryError } from "./errors.ts";

const NO_HOSTS: ReadonlyArray<string> = [] as const;

// Mirrors OpenSSH readconf: the keyword may be followed by one optional "=",
// then the arguments are split like misc.c argv_split() with quotes, the
// escapes \\ \" \' and unquoted "\ ", and "#" starting a comment only at
// the start of a token. Invalid quoting leaves hostname resolution uncertain.
function parseSshConfigLine(line: string) {
  const match = /^\s*([^\s=]+)\s*=?\s*(.*)$/u.exec(line);
  if (!match) {
    return null;
  }

  const directive = match[1]!.toLowerCase();
  const args: Array<string> = [];
  const rest = match[2]!;
  let token: string | null = null;
  let quote: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]!;
    const next = rest[index + 1];
    if (
      char === "\\" &&
      (next === '"' || next === "'" || next === "\\" || (quote === null && next === " "))
    ) {
      token = (token ?? "") + next;
      index += 1;
    } else if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        token = (token ?? "") + char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      token ??= "";
    } else if (/\s/u.test(char)) {
      if (token !== null) {
        args.push(token);
        token = null;
      }
    } else if (char === "#" && token === null) {
      break;
    } else {
      token = (token ?? "") + char;
    }
  }
  if (quote !== null) {
    return { directive, args: null };
  }
  if (token !== null) {
    args.push(token);
  }
  return { directive, args };
}

function expandHomePath(input: string, homeDir: string): string {
  return input.replace(/^~(?=$|\/|\\)/u, homeDir);
}

const resolveSshConfigIncludePattern = Effect.fnUntraced(function* (
  includePattern: string,
  _directory: string,
  homeDir: string,
) {
  const path = yield* Path.Path;
  const expandedPattern = expandHomePath(includePattern, homeDir);
  return path.isAbsolute(expandedPattern)
    ? expandedPattern
    : path.resolve(path.join(homeDir, ".ssh"), expandedPattern);
});

function hasSshPattern(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.startsWith("!");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${escapeRegex(pattern).replace(/\\\*/gu, ".*").replace(/\\\?/gu, ".")}$`,
    "u",
  );
}

const expandGlob = Effect.fnUntraced(function* (pattern: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return (yield* fs.exists(pattern)) ? [pattern] : NO_HOSTS;
  }

  const directory = path.dirname(pattern);
  const basePattern = path.basename(pattern);
  if (!(yield* fs.exists(directory))) {
    return NO_HOSTS;
  }

  const matcher = globToRegExp(basePattern);
  const entries = yield* fs.readDirectory(directory);
  const matchedPaths: string[] = [];
  for (const entry of entries) {
    if (!matcher.test(entry)) {
      continue;
    }
    const entryPath = path.join(directory, entry);
    if (yield* fs.exists(entryPath)) {
      matchedPaths.push(entryPath);
    }
  }
  return matchedPaths.toSorted();
});

type HostCondition = ReadonlyArray<string> | null;

interface HostNameRule {
  readonly conditions: ReadonlyArray<HostCondition>;
  readonly hostname: string | null;
}

function matchesHostPatterns(alias: string, patterns: ReadonlyArray<string>): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const hostPattern = negated ? pattern.slice(1) : pattern;
    const matches =
      hostPattern === "*" ||
      (hasSshPattern(hostPattern) ? globToRegExp(hostPattern).test(alias) : hostPattern === alias);
    if (!matches) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function resolveConfiguredHostname(alias: string, rules: ReadonlyArray<HostNameRule>) {
  for (const { conditions, hostname } of rules) {
    if (
      conditions.some((condition) => condition !== null && !matchesHostPatterns(alias, condition))
    ) {
      continue;
    }
    // SSH takes the first value; an uncertain earlier value blocks later fallbacks.
    if (conditions.includes(null) || hostname === null) return null;
    if (/%(?!h)/u.test(hostname) || hostname.includes("$")) return null;
    return hostname.replaceAll("%h", alias);
  }
  return null;
}

const collectSshConfigAliasesFromFile = Effect.fnUntraced(function* (
  filePath: string,
  visited: Set<string>,
  homeDir: string,
  aliases: Set<string>,
  hostNameRules: Array<HostNameRule>,
  inheritedConditions: ReadonlyArray<HostCondition>,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedPath = path.resolve(filePath);
  if (visited.has(resolvedPath)) {
    // Read each file once, but never reuse its rules under a different Include context.
    hostNameRules.push({ conditions: inheritedConditions, hostname: null });
    return;
  }
  if (!(yield* fs.exists(resolvedPath))) return;
  if ((yield* fs.stat(resolvedPath)).type === "Directory") return;
  visited.add(resolvedPath);

  const directory = path.dirname(resolvedPath);
  const raw = yield* fs.readFileString(resolvedPath);
  let condition: HostCondition = ["*"];

  for (const line of raw.split(/\r?\n/u)) {
    const parsed = parseSshConfigLine(line);
    if (!parsed) continue;
    const { directive, args } = parsed;
    const conditions = [...inheritedConditions, condition];

    if (directive === "host") {
      condition = args;
      for (const alias of args ?? []) {
        if (alias.length > 0 && !hasSshPattern(alias)) aliases.add(alias);
      }
    } else if (directive === "match") {
      condition = null;
    } else if (directive === "hostname") {
      hostNameRules.push({ conditions, hostname: args?.length === 1 ? args[0]! : null });
    } else if (directive === "include") {
      if (args === null) {
        hostNameRules.push({ conditions, hostname: null });
        continue;
      }
      for (const includePattern of args) {
        const resolvedPattern = yield* resolveSshConfigIncludePattern(
          includePattern,
          directory,
          homeDir,
        );
        if (
          /%|\$\{|\[/u.test(includePattern) ||
          (includePattern.startsWith("~") && !/^~(?=$|\/|\\)/u.test(includePattern)) ||
          hasSshPattern(path.dirname(resolvedPattern))
        ) {
          hostNameRules.push({ conditions, hostname: null });
          continue;
        }
        const includedPaths = yield* expandGlob(resolvedPattern);
        for (const includedPath of includedPaths) {
          yield* collectSshConfigAliasesFromFile(
            includedPath,
            visited,
            homeDir,
            aliases,
            hostNameRules,
            conditions,
          );
        }
      }
    }
  }
});

function parseKnownHostsTargets(raw: string): ReadonlyArray<DesktopDiscoveredSshHost> {
  const targets = new Map<string, DesktopDiscoveredSshHost>();

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const withoutMarker = trimmed.startsWith("@")
      ? trimmed.split(/\s+/u).slice(1).join(" ")
      : trimmed;
    const [hostField = ""] = withoutMarker.split(/\s+/u);
    if (hostField.length === 0 || hostField.startsWith("|")) {
      continue;
    }

    for (const rawHost of hostField.split(",")) {
      const withPort = /^\[([^\]]+)\]:(.*)$/u.exec(rawHost) ?? /^([^:]+):([^:]*)$/u.exec(rawHost);
      const host = (withPort?.[1] ?? rawHost).trim();
      if (host.length === 0 || hasSshPattern(host)) {
        continue;
      }
      const portText = withPort?.[2];
      if (portText !== undefined && !/^\d+$/u.test(portText)) continue;
      const port = portText === undefined ? null : Number(portText);
      if (port !== null && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) continue;
      const alias =
        port === null ? host : `ssh://${host.includes(":") ? `[${host}]` : host}:${port}`;
      targets.set(alias, { alias, hostname: host, username: null, port, source: "known-hosts" });
    }
  }

  return [...targets.values()].toSorted((left, right) => left.alias.localeCompare(right.alias));
}

const readKnownHostsTargets = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) return [];
  return parseKnownHostsTargets(yield* fs.readFileString(filePath));
});

export const discoverSshHosts = Effect.fnUntraced(
  function* (input: { readonly homeDir?: string }) {
    const path = yield* Path.Path;
    const env = yield* Config.all({
      home: Config.String("HOME").pipe(Config.option),
      userProfile: Config.String("USERPROFILE").pipe(Config.option),
    });
    const homeDir =
      input?.homeDir ??
      Option.getOrUndefined(env.home) ??
      Option.getOrUndefined(env.userProfile) ??
      "";
    if (homeDir.trim().length === 0) {
      return [];
    }

    const sshDirectory = path.join(homeDir, ".ssh");
    const configAliases = new Set<string>();
    const hostNameRules: Array<HostNameRule> = [];
    yield* collectSshConfigAliasesFromFile(
      path.join(sshDirectory, "config"),
      new Set<string>(),
      homeDir,
      configAliases,
      hostNameRules,
      [],
    );
    const knownHosts = yield* readKnownHostsTargets(path.join(sshDirectory, "known_hosts"));
    const discovered = new Map<string, DesktopDiscoveredSshHost>();

    const configuredHostnames = new Set<string>();
    for (const alias of configAliases) {
      const hostname = resolveConfiguredHostname(alias, hostNameRules);
      if (hostname !== null) configuredHostnames.add(hostname.toLowerCase());
      discovered.set(alias, {
        alias,
        hostname: hostname ?? alias,
        username: null,
        port: null,
        source: "ssh-config",
      });
    }

    for (const target of knownHosts) {
      if (
        discovered.has(target.alias) ||
        (target.port === null && configuredHostnames.has(target.hostname.toLowerCase()))
      ) {
        continue;
      }
      discovered.set(target.alias, target);
    }

    return [...discovered.values()].toSorted((left, right) =>
      left.alias.localeCompare(right.alias),
    );
  },
  Effect.mapError(
    (cause) =>
      new SshHostDiscoveryError({
        message: "Failed to discover SSH hosts.",
        cause,
      }),
  ),
);
