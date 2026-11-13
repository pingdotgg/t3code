// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { AgentScope, AgentScopeThreadId, RAISE_OOM_SCORE_LINE } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./stderr.ts";
import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";

export interface AcpOwnedPosixProcess extends AcpPosixProcessIdentity {
  readonly parentExecutable: string | undefined;
  readonly parentStartTime: string;
}

export class AcpProcessGroupTerminationError extends Schema.TaggedError<AcpProcessGroupTerminationError>()(
  "AcpProcessGroupTerminationError",
  {
    detail: Schema.String,
    pid: Schema.optionalKey(Schema.Int),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const isAcpProcessGroupTerminationError = Schema.is(AcpProcessGroupTerminationError);

export interface AcpPosixProcessIdentity {
  readonly executable: string | undefined;
  readonly pgid: number;
  readonly pid: number;
  readonly ppid: number;
  readonly sid: number;
  readonly state?: string;
  readonly startTime: string;
}

export interface AcpPosixProcessTreeController {
  readonly childPidsOf: (pid: number) => ReadonlyArray<number>;
  readonly childrenOf: (pid: number) => ReadonlyArray<AcpPosixProcessIdentity>;
  readonly identity: (pid: number) => AcpPosixProcessIdentity | undefined;
  readonly snapshot: () => ReadonlyArray<AcpPosixProcessIdentity>;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
}

export interface AcpLinuxCgroupLease {
  readonly contains: (pid: number) => boolean;
  readonly exists: () => boolean;
  readonly path: string;
  readonly relativePath: string;
  readonly kill: () => void;
  readonly populated: () => boolean;
  readonly remove: () => void;
}

export interface AcpLinuxCgroupController {
  readonly create: () => AcpLinuxCgroupLease | undefined;
}

export interface AcpPosixOwnershipRoot {
  captureAttempted?: boolean;
  value: AcpOwnedPosixProcess | undefined;
}

export function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseUnifiedCgroupPath(contents: string): string | undefined {
  const matches = [...contents.matchAll(/^0::(\/.*)$/gm)];
  return matches.length === 1 ? matches[0]![1] : undefined;
}

export function isSafeCgroupPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.includes("(deleted)") &&
    NodePath.posix.normalize(value) === value
  );
}

export function parseCgroup2Mounts(
  contents: string,
): ReadonlyArray<{ readonly mountPoint: string; readonly root: string }> {
  const mounts: Array<{ readonly mountPoint: string; readonly root: string }> = [];
  for (const line of contents.split("\n")) {
    const [mount, filesystem] = line.split(" - ");
    if (mount === undefined || filesystem?.split(" ")[0] !== "cgroup2") continue;
    const fields = mount.split(" ");
    if (fields.length < 5) continue;
    mounts.push({
      mountPoint: decodeMountInfoPath(fields[4]!),
      root: decodeMountInfoPath(fields[3]!),
    });
  }
  return mounts;
}

export function wrapCommandForLinuxCgroup(
  lease: AcpLinuxCgroupLease,
  command: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      [
        "lease_path=$1; expected=$2; shift 2",
        RAISE_OOM_SCORE_LINE,
        'printf "%s\\n" "$$" > "$lease_path/cgroup.procs" || exit 125',
        "actual=",
        "while IFS= read -r line; do",
        '  case "$line" in 0::*) [ -z "$actual" ] || exit 126; actual=${line#0::};; esac',
        "done < /proc/self/cgroup || exit 125",
        '[ "$actual" = "$expected" ] || exit 126',
        "unset ELECTRON_RUN_AS_NODE T3_ACP_CGROUP_WRAPPER",
        "trap 'exit 125' 0",
        // Bash can skip EXIT traps on failed exec; reject invalid targets with path and exit 125.
        '[ -f "$1" ] && [ -x "$1" ] || { printf "%s: %s: not an executable file\\n" "$0" "$1" >&2; exit 125; }',
        'exec "$@"',
      ].join("\n"),
      "t3-acp-cgroup-wrapper",
      lease.path,
      lease.relativePath,
      command,
      ...args,
    ],
  };
}

export function resolveLinuxCgroupTargetCommand(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  // Match Node spawn: only undefined PATH gets a fallback; empty PATH searches cwd.
  const pathEnv = environment.PATH === undefined ? "/usr/bin:/bin" : environment.PATH;
  const candidates = command.includes(NodePath.sep)
    ? [NodePath.resolve(cwd, command)]
    : pathEnv
        .split(NodePath.delimiter)
        .map((entry) =>
          NodePath.join(
            entry.length === 0
              ? cwd
              : NodePath.isAbsolute(entry)
                ? entry
                : NodePath.resolve(cwd, entry),
            command,
          ),
        );
  for (const candidate of candidates) {
    try {
      if (!NodeFS.statSync(candidate).isFile()) continue;
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export const STALE_ACP_CGROUP_SIBLING = /^t3-acp-(\d+)-/;

export interface SweepStaleLinuxCgroupSiblingsOptions {
  readonly currentPid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly readPopulated?: (siblingPath: string) => "0" | "1" | undefined;
  readonly remove?: (siblingPath: string) => void;
}

export function defaultCgroupOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

export function defaultReadCgroupPopulated(siblingPath: string): "0" | "1" | undefined {
  const state = /(?:^|\n)populated ([01])(?:\n|$)/.exec(
    NodeFS.readFileSync(NodePath.join(siblingPath, "cgroup.events"), "utf8"),
  )?.[1];
  return state === "0" || state === "1" ? state : undefined;
}

export function sweepStaleLinuxCgroupSiblings(
  parentPath: string,
  options: SweepStaleLinuxCgroupSiblingsOptions = {},
): void {
  const currentPid = options.currentPid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultCgroupOwnerIsAlive;
  const readPopulated = options.readPopulated ?? defaultReadCgroupPopulated;
  const remove = options.remove ?? ((siblingPath: string) => NodeFS.rmdirSync(siblingPath));
  try {
    for (const entry of NodeFS.readdirSync(parentPath, { withFileTypes: true })) {
      try {
        if (!entry.isDirectory()) continue;
        const match = STALE_ACP_CGROUP_SIBLING.exec(entry.name);
        if (match === null) continue;
        const ownerPid = Number(match[1]);
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || ownerPid === currentPid) continue;
        if (isProcessAlive(ownerPid)) continue;
        const siblingPath = NodePath.join(parentPath, entry.name);
        if (NodePath.dirname(siblingPath) !== parentPath) continue;
        if (readPopulated(siblingPath) !== "0") continue;
        remove(siblingPath);
      } catch {}
    }
  } catch {}
}

export function tryCreateLinuxCgroupLease(
  currentRelative: string,
  mount: { readonly mountPoint: string; readonly root: string },
): AcpLinuxCgroupLease | undefined {
  if (
    !isSafeCgroupPath(mount.root) ||
    !isSafeCgroupPath(mount.mountPoint) ||
    !(
      mount.root === "/" ||
      currentRelative === mount.root ||
      currentRelative.startsWith(`${mount.root}/`)
    )
  ) {
    return undefined;
  }
  const mountRelative =
    mount.root === "/" ? currentRelative : currentRelative.slice(mount.root.length);
  const currentPath = NodePath.resolve(mount.mountPoint, `.${mountRelative}`);
  const resolvedMount = NodePath.resolve(mount.mountPoint);
  if (currentPath !== resolvedMount && !currentPath.startsWith(`${resolvedMount}${NodePath.sep}`)) {
    return undefined;
  }
  sweepStaleLinuxCgroupSiblings(currentPath);
  const childName = `t3-acp-${process.pid}-${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const childPath = NodePath.join(currentPath, childName);
  const childRelative = NodePath.posix.join(currentRelative, childName);
  if (NodePath.dirname(childPath) !== currentPath) return undefined;
  try {
    NodeFS.mkdirSync(childPath, { mode: 0o700 });
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.procs"), NodeFS.constants.W_OK);
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.kill"), NodeFS.constants.W_OK);
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.events"), NodeFS.constants.R_OK);
    if (NodeFS.readFileSync(NodePath.join(childPath, "cgroup.type"), "utf8").trim() !== "domain") {
      throw new Error("ACP cgroup is not a domain cgroup");
    }
    if (typeof process.execve !== "function") throw new Error("process.execve is unavailable");
  } catch {
    try {
      NodeFS.rmdirSync(childPath);
    } catch {}
    return undefined;
  }
  return {
    contains: (pid) =>
      parseUnifiedCgroupPath(NodeFS.readFileSync(`/proc/${pid}/cgroup`, "utf8")) === childRelative,
    exists: () => NodeFS.existsSync(childPath),
    path: childPath,
    relativePath: childRelative,
    kill: () => NodeFS.writeFileSync(NodePath.join(childPath, "cgroup.kill"), "1\n"),
    populated: () => {
      const state = /(?:^|\n)populated ([01])(?:\n|$)/.exec(
        NodeFS.readFileSync(NodePath.join(childPath, "cgroup.events"), "utf8"),
      )?.[1];
      if (state === undefined) throw new Error("ACP cgroup.events has no populated state");
      return state === "1";
    },
    remove: () => {
      const directories = (path: string): ReadonlyArray<string> =>
        NodeFS.readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? [...directories(NodePath.join(path, entry.name)), NodePath.join(path, entry.name)]
            : [],
        );
      for (const directory of directories(childPath)) NodeFS.rmdirSync(directory);
      NodeFS.rmdirSync(childPath);
    },
  };
}

export function makeLinuxCgroupController(): AcpLinuxCgroupController {
  return {
    create: () => {
      let currentRelative: string | undefined;
      let mounts: ReadonlyArray<{ readonly mountPoint: string; readonly root: string }> = [];
      try {
        currentRelative = parseUnifiedCgroupPath(NodeFS.readFileSync("/proc/self/cgroup", "utf8"));
        mounts = parseCgroup2Mounts(NodeFS.readFileSync("/proc/self/mountinfo", "utf8"));
      } catch {
        return undefined;
      }
      if (
        currentRelative === undefined ||
        !currentRelative.startsWith("/") ||
        mounts.length === 0
      ) {
        return undefined;
      }
      if (!isSafeCgroupPath(currentRelative)) return undefined;
      // Multi-mount hosts often list a read-only view before the delegated one.
      for (const mount of mounts) {
        const lease = tryCreateLinuxCgroupLease(currentRelative, mount);
        if (lease !== undefined) return lease;
      }
      return undefined;
    },
  };
}
