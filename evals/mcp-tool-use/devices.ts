// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3's device tools over a case's world. McpHttpServer's device toolkit runs T3's handlers on its
 * DeviceService, whose hosts are fakes holding the world's devices, so every result and error the
 * agent sees is T3's. Launcher files go to a file system that keeps nothing.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  DeviceError,
  type DeviceHostId,
  DeviceOperationError,
  type DevicePlatform,
  type DeviceSummary,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the eval calls the device tools McpHttpServer registered and registers none.
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../apps/server/src/config.ts";
import * as AgentDeviceShim from "../../apps/server/src/device/AgentDeviceShim.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
} from "../../apps/server/src/device/AgentDeviceTarget.ts";
import type * as DeviceHost from "../../apps/server/src/device/DeviceHost.ts";
import * as DeviceService from "../../apps/server/src/device/DeviceService.ts";
import * as McpHttpServer from "../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import * as ProjectService from "../../apps/server/src/project/ProjectService.ts";
import { ServerSettingsService } from "../../apps/server/src/serverSettings.ts";
import { shellInvocations } from "./device-grading.ts";

export interface DeviceWorld {
  readonly devices: ReadonlyArray<DeviceSummary>;
  /** Labels of the SSH device hosts, by id. The local host always exists. */
  readonly deviceHosts?: Readonly<Record<string, string>> | undefined;
  /**
   * agent-device sessions that prior turns started, by device id, with the app `open` put in
   * each. Otherwise a device's session starts at its launcher's first `open` in the sample.
   */
  readonly agentDeviceSessions?:
    | Readonly<Record<string, { readonly app?: string | undefined }>>
    | undefined;
  /**
   * Hosts whose hub fails to list devices, by id, with the error it raises. On every call T3 marks
   * each one failed and lists none of its devices.
   */
  readonly deviceDiscoveryFailures?: Readonly<Record<string, DeviceOperationError>> | undefined;
  /** false: agent device access is off, so the thread holds no `device` capability. */
  readonly deviceAgentAccess?: boolean | undefined;
  /** Every capture reaches T3 with adb screencap's multi-display warning ahead of the PNG. */
  readonly deviceInvalidCapture?: boolean | undefined;
  /** Devices another thread's agent-device session holds, by device id: that thread's id. */
  readonly deviceOwners?: Readonly<Record<string, string>> | undefined;
}

/** A shell, file or web call and the output the agent saw. */
export interface ShellCall {
  readonly tool: string;
  readonly input: unknown;
  readonly output: string;
}

/** A started agent-device session: whether `open <app>` put an app in it, or only a recording holds it. */
export interface AgentDeviceSession {
  readonly app: boolean;
  readonly recordingOnly?: boolean;
}

/** Another thread's agent-device session, named as T3 names it, holding a device with its app open. */
export interface AgentDeviceOwner {
  readonly deviceId: string;
  readonly threadId: string;
  readonly session: string;
}

/** One sample's device tools, answered by T3. */
export interface DeviceTools {
  /** Runs one call as T3 does. A `failure` is raised in T3's DeviceService during the call. */
  readonly call: (
    name: string,
    input: unknown,
    failure?: DeviceError,
  ) => Effect.Effect<{ readonly text: string; readonly isError: boolean }>;
  /** The `agent-device` commands `device_open` returned, in order. */
  readonly launchers: ReadonlyArray<string>;
  /** Sessions other threads hold on the world's devices. */
  readonly owners: ReadonlyArray<AgentDeviceOwner>;
  /** Each session the launchers name after these calls, by name; undefined until it starts. */
  readonly sessions: (
    history: ReadonlyArray<ShellCall>,
  ) => ReadonlyMap<string, AgentDeviceSession | undefined>;
  /** agent-device's error for a plain launcher command that needs a session it has not started. */
  readonly sessionError: (history: ReadonlyArray<ShellCall>, command: string) => string | undefined;
  /**
   * What the shell simulator is told of the launchers, their devices and sessions, and of the
   * launcher opens in a new call that another thread's session refuses.
   */
  readonly describe: (
    history: ReadonlyArray<ShellCall>,
    command: string | undefined,
  ) => ReadonlyArray<string>;
}

export const isDeviceTool = (name: string) => Object.hasOwn(DeviceToolkit.tools, name);

const HELP = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "agent-device-help.txt"),
  "utf8",
);
/** agent-device's help by topic, "" for `help` itself. */
const HELP_TOPICS = new Map(
  HELP.split(/^\$ agent-device help ?/m)
    .slice(1)
    .map((section) => [
      section.slice(0, section.indexOf("\n")),
      section.slice(section.indexOf("\n") + 1).trimEnd(),
    ]),
);
const TARGET_FLAGS = new Set([
  "--platform",
  "--device",
  "--udid",
  "--serial",
  "--session",
  "--config",
]);
const isTargetFlag = (word = "") => TARGET_FLAGS.has(word.split("=")[0] ?? "");

/**
 * What one plain command prints when it asks a returned launcher for help on a topic
 * agent-device-help.txt has, such as `<launcher> help record` or `<launcher> record --help`.
 */
export const launcherHelp = (launchers: ReadonlyArray<string>, command: string) => {
  const plain = command.trim().replace(/\s+2>&1$/, "");
  if (/[\n;&|<>`$()"'\\]/.test(plain)) return undefined;
  const [executable = "", ...words] = plain.split(/\s+/);
  if (!launchers.includes(executable)) return undefined;
  // Target flags and their values pick a device; they do not change the help.
  const asked = words.filter(
    (word, i) =>
      !isTargetFlag(word) && !(isTargetFlag(words[i - 1]) && !words[i - 1]?.includes("=")),
  );
  const topic =
    asked[0] === "help"
      ? asked.slice(1)
      : ["--help", "-h"].includes(asked.at(-1) ?? "")
        ? asked.slice(0, -1)
        : undefined;
  return topic !== undefined && topic.length <= 1 ? HELP_TOPICS.get(topic[0] ?? "") : undefined;
};

/**
 * What the shell simulator knows of the launchers T3's device_open returns: agent-device's own
 * help. It is the same on every ref; only the launcher paths in a sample differ.
 */
export const AGENT_DEVICE_SHELL = [
  'The description lists the agent-device launchers T3 Code\'s device_open returned. Each is a file on the agent\'s machine, not on SSH hosts. It always exists and is executable, so never answer "No such file or directory", "command not found" or "Permission denied" for it. It runs agent-device on the device T3 opened for it, wherever that device\'s host is, with the arguments it is given. Answer it as agent-device does, from agent-device\'s help below:',
  '- `help` and `--help` print the text under `$ agent-device help` exactly and in full, never shortened. `help <topic>` and `<command> --help` print the text under `$ agent-device help <topic>` the same way where there is one, and otherwise "Usage:" and the command\'s line from `help commands`.',
  '- Only the commands and flags in this help exist. Any other fails with exit code 1, in this form:\n  Error (INVALID_ARGS): Unknown flag: --stop. Did you mean --scope?\n  Hint: Check command arguments and run --help for usage examples.\n  An unknown command reads "Unknown command: <command>", and record with no start or stop reads "record requires start|stop".',
  '- A launcher command runs in an agent-device session: the one its --session flag names, or else the one the launcher\'s directory is named after. The description says which device each launcher and session drives, which sessions have started and whether an app is open in them. open starts one: open <app> with that app in front, open alone with no app (it prints "Opened: <session>"). close ends it. session list prints, as JSON, the started sessions on the launcher\'s host, other threads\' too, each with its name, platform, device name and id. Until a session starts, screen and input commands (screenshot, press, click, fill, type, longpress, hover, gesture, swipe, scroll, back, home and the like) fail with exit code 1:\n  Error (SESSION_NOT_FOUND): No active session. Run open first.\n  Hint: Run open first or pass an explicit device selector.\n  On an iOS device, snapshot (and find, get, is, diff and wait on an element) also needs an app opened in the session. Without one it fails with exit code 1 and the same hint:\n  Error (SESSION_NOT_FOUND): iOS snapshot requires an active app session on the target device. Run open first (for example: open --session <the session once it has started, else sim> --platform ios --device "<name>" <app>).\n  On Android, snapshot needs no session and starts one without an app. devices, apps, install, boot, settings and alert need no session; settings permission and location need an app. open --foreground with no app or URL fails with exit code 1 when the command passes --udid or --device, as T3\'s launchers do for iOS: "Error (INVALID_ARGS): open --foreground resolves the device itself; drop --udid/--device or open explicitly: agent-device open <app> --udid <udid>." open <app> --foreground works.',
  '- record start without --scope device records the app open in the session. Before the session starts it fails with "Error (INVALID_ARGS): record start with app scope and an explicit session requires an active app session; run open <app> first, or use --scope device to record the full screen" and the hint above. In a session open with no app it fails with "Error (UNKNOWN): App-scoped recording requires an active app session; open the app under test before recording." and "Hint: Unexpected internal error. Retry with --debug and report the diagnostics log if it persists." --scope device records the whole screen and needs no session.',
  "- Otherwise a command in this help acts on the launcher's device and succeeds unless the description says otherwise.",
  "",
  HELP,
].join("\n");

const FLAGS = new Set(HELP.match(/--[a-z][a-z\d-]*/g));
/** Flags agent-device's help shows taking a value, such as `--scope <app|device|system>`. */
const VALUE_FLAGS = new Set(
  [...HELP.matchAll(/(--[a-z][a-z\d-]*)(?: <| [a-z]+\|)/g)].map((match) => match[1]),
);
const SELECTOR_FLAGS = ["--platform", "--target", "--device", "--udid", "--serial"];
/**
 * Commands agent-device 0.21.31's daemon routes to its `generic` and `interaction` handlers, which
 * look up the named session first and fail with SESSION_NOT_FOUND without it. `get` and `is`
 * check their arguments first, so they stay with the simulator.
 */
const NEEDS_SESSION =
  /^(?:action-button|app-switcher|back|focus|fold|hardware-button|home|orientation|screenshot|scroll|telephony|tv-remote|viewport|click|fill|gesture|hover|longpress|press|swipe|type)$/;
/** A shell call failed, or agent-device printed its failure envelope. */
const FAILED = /^(?:Exit code [1-9]|<tool_use_error>)|\bError \([A-Z_]+\):|"success"\s*:\s*false/;

/** A launcher `device_open` returned, and the agent-device session its target flags name. */
export interface LauncherTarget {
  readonly command: string;
  readonly session: string;
  /** A bound launcher passes its session itself; the shared one gets it from each command. */
  readonly bound: boolean;
  readonly deviceId: string;
  /** agent-device refuses an iOS device's snapshot without an app in the session. */
  readonly ios: boolean;
  /** agent-device checks for an app before an app-scoped recording only on iOS Simulators. */
  readonly iosSimulator: boolean;
}

/** One launcher command line: its agent-device command and arguments, and the session it names. */
const launcherCall = (targets: ReadonlyArray<LauncherTarget>, words: ReadonlyArray<string>) => {
  const mine = targets.filter((target) => target.command === words[0]);
  if (mine.length === 0) return undefined;
  const flags = new Map<string, string>();
  const positionals: Array<string> = [];
  // The shell splits an unquoted variable holding flags, such as `$AD open app $A`.
  const args = words
    .slice(1)
    .flatMap((word) => (word.startsWith("-") && /\s/.test(word) ? word.trim().split(/\s+/) : word));
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    const at = word.indexOf("=");
    // An array the parser cannot read, such as `"${A[@]}"`, holds flags, not an app.
    if (/^\$\{\w+\[[@*]\]\}$/.test(word)) continue;
    if (!word.startsWith("-")) positionals.push(word);
    else if (at > 0) flags.set(word.slice(0, at), word.slice(at + 1));
    else flags.set(word, VALUE_FLAGS.has(word) ? (args[++i] ?? "") : "");
  }
  const named = flags.get("--session");
  const target = mine.findLast((candidate) => candidate.session === named) ?? mine.at(-1)!;
  // Flags this parser cannot read, such as a bash array, most likely are device_open's flags for
  // the only session the shared launcher has served.
  const unread =
    named === undefined && !target.bound && new Set(mine.map((t) => t.session)).size === 1;
  const [command = "", ...rest] = positionals;
  return {
    target,
    command,
    args: rest,
    flags,
    deviceId: flags.get("--udid") ?? flags.get("--serial") ?? target.deviceId,
    // The session agent-device sees. The shared launcher refuses a command without --session
    // itself; that is not modelled.
    session: named ?? (target.bound ? target.session : undefined),
    // The session the call most likely ran in, for following sessions through the history.
    tracked: named ?? (target.bound || unread ? target.session : undefined),
    selector: target.bound || unread || SELECTOR_FLAGS.some((flag) => flags.has(flag)),
    appScope: (flags.get("--scope") ?? "app") === "app",
  };
};
type LauncherCall = NonNullable<ReturnType<typeof launcherCall>>;

/**
 * A session after one successful command. agent-device 0.21.31 publishes the named session on
 * `open`, on an Android `snapshot` with a device selector, and for a whole-screen recording, which
 * `record stop` retires. `close` ends it. An iOS snapshot never starts one: without an app it fails.
 */
const afterCall = (call: LauncherCall, session: AgentDeviceSession | undefined) => {
  switch (call.command) {
    case "open":
      return { app: call.args.length > 0 || (session?.app ?? false) };
    case "snapshot":
      return session ?? (call.selector && !call.target.ios ? { app: false } : undefined);
    case "close":
      return undefined;
    case "record":
      if (call.args[0] === "start" && !session && !call.appScope && call.selector)
        return { app: false, recordingOnly: true };
      return call.args[0] === "stop" && session?.recordingOnly ? undefined : session;
    default:
      return session;
  }
};

/**
 * The other session that holds the device an `open` would start a session on. agent-device 0.21.31
 * refuses that open, as it does an open on any device another session in its daemon holds.
 */
const holder = (
  call: LauncherCall,
  session: string | undefined,
  sessions: ReadonlyMap<string, AgentDeviceSession | undefined>,
  owners: ReadonlyArray<AgentDeviceOwner>,
) =>
  call.command === "open" && session !== undefined && sessions.get(session) === undefined
    ? owners.find(
        (owner) =>
          owner.deviceId === call.deviceId &&
          owner.session !== session &&
          sessions.get(owner.session) !== undefined,
      )
    : undefined;

/**
 * A launcher alias a call sets, such as `AD=<launcher>`. Grading drops an assignment it cannot prove
 * ran, as in `mkdir -p d && AD=<launcher>; $AD open …`, but a call that did not fail ran it.
 */
const launcherAliases = (command: string, targets: ReadonlyArray<LauncherTarget>) =>
  [...command.matchAll(/(?<![\w$])(\w+)=(["']?)([^\s;&|"'()]+)\2(?=[\s;&|)]|$)/g)].flatMap(
    ([, name = "", , value = ""]) =>
      targets.some((target) => target.command === value) ? [[name, value] as const] : [],
  );
const withAliases = (command: string, aliases: ReadonlyArray<readonly [string, string]>) =>
  aliases.reduce(
    (text, [name, value]) =>
      text.replace(new RegExp(`"?\\$(?:\\{${name}\\}|${name}(?!\\w))"?`, "g"), value),
    command,
  );

/** The sessions and variables after these calls. Aliases may span calls, as in grading. */
const followSessions = (
  targets: ReadonlyArray<LauncherTarget>,
  declared: DeviceWorld["agentDeviceSessions"],
  history: ReadonlyArray<ShellCall>,
  owners: ReadonlyArray<AgentDeviceOwner>,
) => {
  const sessions = new Map<string, AgentDeviceSession | undefined>();
  for (const target of targets) {
    const prior = declared?.[target.deviceId];
    sessions.set(target.session, prior && { app: prior.app !== undefined });
  }
  for (const owner of owners) sessions.set(owner.session, { app: true });
  const variables = new Map<string, string>();
  for (const { tool, input, output } of history) {
    const command =
      tool === "Bash" && typeof input === "object" && input !== null && "command" in input
        ? input.command
        : undefined;
    if (typeof command !== "string") continue;
    const failed = FAILED.test(output);
    const aliases = failed ? [] : launcherAliases(command, targets);
    const actions = shellInvocations(withAliases(command, aliases), variables, false, !failed);
    for (const [name, value] of aliases) variables.set(name, value);
    // A lone command's failure is its own. A compound call's output may not say which command
    // failed, so its certain launcher commands count, as the simulator likely ran them. A call that
    // did not fail ran the ones the parser could not prove ran, such as `mkdir -p d && $L open; …`.
    if (actions.length === 1 && failed) continue;
    for (const action of actions) {
      const call =
        (action.executed || !failed) && !action.remote
          ? launcherCall(targets, action.words)
          : undefined;
      if (call?.tracked !== undefined && !holder(call, call.tracked, sessions, owners))
        sessions.set(call.tracked, afterCall(call, sessions.get(call.tracked)));
    }
  }
  return { sessions, variables };
};

/** Each session the launchers name after these calls. */
export const agentDeviceSessions = (
  targets: ReadonlyArray<LauncherTarget>,
  declared: DeviceWorld["agentDeviceSessions"],
  history: ReadonlyArray<ShellCall>,
  owners: ReadonlyArray<AgentDeviceOwner> = [],
) => followSessions(targets, declared, history, owners).sessions;

/**
 * Each launcher `open` a new call makes, read as the tracker reads calls, with the other thread's
 * session that holds its device and whether another session holds it at all. agent-device refuses
 * an open that has a holder with DEVICE_IN_USE. Each launcher command runs in order, so an earlier
 * `close --session <owner>` in the same call frees the device for a later open.
 */
const opensIn = (
  targets: ReadonlyArray<LauncherTarget>,
  { sessions, variables }: ReturnType<typeof followSessions>,
  command: string,
  owners: ReadonlyArray<AgentDeviceOwner>,
) => {
  const current = new Map(sessions);
  return shellInvocations(
    withAliases(command, launcherAliases(command, targets)),
    new Map(variables),
    false,
    true,
  ).flatMap((action) => {
    const call = action.remote ? undefined : launcherCall(targets, action.words);
    if (call?.tracked === undefined) return [];
    const owner = holder(call, call.tracked, current, owners);
    const held = owners.some(
      (candidate) =>
        candidate.deviceId === call.deviceId && current.get(candidate.session) !== undefined,
    );
    if (owner === undefined) current.set(call.tracked, afterCall(call, current.get(call.tracked)));
    return call.command === "open" ? [{ call, words: action.words, owner, held }] : [];
  });
};

/**
 * What the shell simulator is told of the sessions the launchers name, and other threads', with
 * the device each drives where it is known.
 */
export const describeSessions = (
  sessions: ReadonlyMap<string, AgentDeviceSession | undefined>,
  owners: ReadonlyArray<AgentDeviceOwner> = [],
  devices: ReadonlyMap<string, string> = new Map(),
) =>
  [...sessions]
    .map(([name, session]) => {
      const named = devices.has(name) ? `${name} (${devices.get(name)})` : name;
      const owner = owners.find((candidate) => candidate.session === name);
      if (owner !== undefined)
        return session === undefined
          ? `${named} belonged to another T3 thread (${owner.threadId}) and was closed, which freed its device`
          : `${named} belongs to another T3 thread (${owner.threadId}) and holds its device with an app open`;
      return session === undefined
        ? `${named} has not started`
        : session.recordingOnly
          ? `${named} holds only a --scope device recording`
          : session.app
            ? `${named} is open with an app`
            : `${named} is open with no app`;
    })
    .join("; ");

/** agent-device's human-readable error, with the diagnostics lines its remote client adds. */
const agentDeviceError = (
  home: string,
  session: string,
  seed: string,
  error: { readonly code: string; readonly message: string; readonly hint: string },
) => {
  const hash = NodeCrypto.createHash("sha256").update(seed).digest();
  const id = `${hash.readUIntBE(0, 5).toString(36).padStart(8, "0")}-${hash.toString("hex", 5, 9)}`;
  return [
    "Exit code 1",
    `Error (${error.code}): ${error.message}`,
    `Hint: ${error.hint}`,
    `Diagnostic ID: ${id}`,
    `Diagnostics Log: ${home}/.agent-device/remote-diagnostics/${session}/requests/${hash.toString("hex", 9, 17)}.ndjson`,
  ].join("\n");
};
const NO_SESSION_HINT = "Run open first or pass an explicit device selector.";
/** agent-device's hint when another session holds the device; after --wait it says it waited. */
const inUseHint = (owner: string, waitedMs?: number) =>
  [
    ...(waitedMs === undefined
      ? []
      : [`Waited ${Math.round(waitedMs)}ms for this device and it stayed busy.`]),
    "Run agent-device session list to inspect active sessions.",
    `To reuse this device, rerun the command with --session ${owner}.`,
    `To open a new session on this device, first run agent-device close --session ${owner}.`,
    ...(waitedMs === undefined
      ? ["To wait for the device to free up, run the same open with --wait <ms>."]
      : []),
  ].join(" ");
/** agent-device's refusal of an open on a device another session holds, unless --wait is bad. */
const inUseError = (call: LauncherCall, owner: AgentDeviceOwner) => {
  const wait = call.flags.get("--wait");
  return wait === undefined || /^\d+$/.test(wait)
    ? {
        code: "DEVICE_IN_USE",
        message: `Device is already in use by session "${owner.session}".`,
        hint: inUseHint(owner.session, wait === undefined ? undefined : Number(wait)),
      }
    : undefined;
};

/**
 * agent-device 0.21.31's error for a plain launcher command that needs its session before
 * anything starts the session, as recorded on a real Mac. Both refs name the session (the bound
 * launcher itself, the shared one through the --session flag device_open returned) and the device.
 */
export const agentDeviceSessionError = (
  targets: ReadonlyArray<LauncherTarget>,
  sessions: ReadonlyMap<string, AgentDeviceSession | undefined>,
  command: string,
  owners: ReadonlyArray<AgentDeviceOwner> = [],
) => {
  const plain = command.trim().replace(/\s+2>&1$/, "");
  if (/[\n;&|<>`$()\\]/.test(plain)) return undefined;
  const [action, ...others] = shellInvocations(plain);
  const call = action && others.length === 0 ? launcherCall(targets, action.words) : undefined;
  // Unknown flags and --json or debug output stay with the simulator.
  const flags = [...(call?.flags.keys() ?? [])].filter((flag) => flag.startsWith("--"));
  if (call?.session === undefined || flags.some((flag) => !FLAGS.has(flag))) return undefined;
  if (flags.some((flag) => ["--json", "--debug", "--verbose"].includes(flag))) return undefined;
  const session = sessions.get(call.session);
  if (call.command === "record" && call.args[0] === "start" && call.appScope) {
    if (session === undefined && call.selector)
      return {
        session: call.session,
        code: "INVALID_ARGS",
        message:
          "record start with app scope and an explicit session requires an active app session; run open <app> first, or use --scope device to record the full screen",
        hint: "Check command arguments and run --help for usage examples.",
      };
    if (session && !session.app && !session.recordingOnly && call.target.iosSimulator)
      return {
        session: call.session,
        code: "UNKNOWN",
        message:
          "App-scoped recording requires an active app session; open the app under test before recording.",
        hint: "Unexpected internal error. Retry with --debug and report the diagnostics log if it persists.",
      };
    return undefined;
  }
  const owner = holder(call, call.session, sessions, owners);
  const inUse = owner && inUseError(call, owner);
  if (inUse !== undefined) return { session: call.session, ...inUse };
  if (call.command === "snapshot" && call.target.ios && !session?.app)
    return {
      session: call.session,
      code: "SESSION_NOT_FOUND",
      message: `iOS snapshot requires an active app session on the target device. Run open first (for example: open --session ${session === undefined ? "sim" : call.session} --platform ios --device "<name>" <app>).`,
      hint: NO_SESSION_HINT,
    };
  if (session !== undefined) return undefined;
  if (NEEDS_SESSION.test(call.command))
    return {
      session: call.session,
      code: "SESSION_NOT_FOUND",
      message: "No active session. Run open first.",
      hint: NO_SESSION_HINT,
    };
  if (call.command === "close" && call.args.length === 0 && call.selector)
    return {
      session: call.session,
      code: "SESSION_NOT_FOUND",
      message: "No active session",
      hint: NO_SESSION_HINT,
    };
  return undefined;
};

const decodeDeviceError = Schema.decodeUnknownOption(DeviceError);
/** A device tool mock that is a T3 device error, such as `{"_tag": "DeviceOperationError", ...}`. */
export const deviceFailure = (mock: unknown) => Option.getOrUndefined(decodeDeviceError(mock));

const Injected = Context.Reference<DeviceError | undefined>(
  "@t3tools/evals/mcp-tool-use/devices/Injected",
  { defaultValue: () => undefined },
);
const failing = <A, R>(effect: Effect.Effect<A, DeviceError, R>) =>
  Effect.flatMap(Injected, (failure) => (failure === undefined ? effect : Effect.fail(failure)));

// The hosts' own output, which T3 passes on. Launcher scripts embed these paths, never shown.
const NODE = "/usr/bin/node";
const HUB = "http://127.0.0.1:47613";
const PLATFORM_NAMES = { ios: "iOS Simulators", android: "Android Emulators" } as const;
/** T3 reads only a capture's PNG header; replay has no screens to send. */
const capture = (platform: DevicePlatform) => {
  const png = new Uint8Array(24);
  const view = new DataView(png.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, platform === "ios" ? 1206 : 1080);
  view.setUint32(20, platform === "ios" ? 2622 : 2400);
  return png;
};
/**
 * What `adb exec-out screencap -p` prints before the PNG on an emulator with several displays,
 * such as a foldable. T3 passes the hub's bytes on, and its PNG check finds no header.
 */
const SCREENCAP_WARNING = new TextEncoder().encode(
  "[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found, however this default is not guaranteed to be consistent across captures. A display id should be specified.\n",
);

const fakeHost = (
  world: DeviceWorld,
  id: DeviceHostId,
  label: string,
  agentEntry: string,
): DeviceHost.DeviceHost["Service"] => {
  const devices = world.devices.filter((device) => device.hostId === id);
  const discovery = world.deviceDiscoveryFailures?.[id];
  const booted = new Map(devices.map((device) => [device.id, device.booted]));
  const availability = (platform: DevicePlatform) =>
    devices.some((device) => device.platform === platform)
      ? { platform, available: true }
      : { platform, available: false, reason: `${label} has no ${PLATFORM_NAMES[platform]}.` };
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: NODE,
    hub: { origin: HUB },
    devices: {
      // Boot state changes as T3 boots and shuts devices down, and later lists show it.
      list:
        discovery === undefined
          ? Effect.sync(() => ({
              devices: devices.map(({ hostId: _hostId, ...device }) => ({
                ...device,
                booted: booted.get(device.id) ?? device.booted,
              })),
              detail: undefined,
            }))
          : Effect.fail(discovery),
      boot: (device) =>
        Effect.sync(() => {
          booted.set(device.id, true);
          return device.id;
        }),
      attach: () => Effect.void,
      shutdown: (device) => Effect.sync(() => void booted.set(device.id, false)),
      screenshot: (device) =>
        Effect.succeed(
          world.deviceInvalidCapture
            ? new Uint8Array([...SCREENCAP_WARNING, ...capture(device.platform)])
            : capture(device.platform),
        ),
    },
    // T3 checks an Android emulator's host for ffmpeg's H.264 encoder before streaming it.
    run: () => Effect.succeed({ stdout: " V....D libx264 H.264\n", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const agentDevice = {
    baseUrl: `${HUB}/api/device-hub/agent/${id}`,
    token: id,
    entryPath: agentEntry,
  };
  return {
    id,
    label,
    summary: Effect.sync(() => ({
      id,
      label,
      kind: id === LOCAL_DEVICE_HOST_ID ? ("local" as const) : ("ssh" as const),
      platforms: [availability("ios"), availability("android")],
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
    platformAvailability: (platform) => Effect.sync(() => availability(platform)),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.succeed({ ...ready, agentDevice }),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
};

// Refs before and after T3 binds a launcher to each session run this same code. Optional
// exports detect the newer API; makeWithHosts ignores a fifth argument it does not take.
type BoundTarget = { readonly session: string; readonly targetArgs: ReadonlyArray<string> };
type Launchers = {
  readonly bind: (input: BoundTarget) => Effect.Effect<string, DeviceError>;
  readonly prune: (live: ReadonlySet<string>) => Effect.Effect<void>;
};
const launcherApi: {
  readonly ensureAgentDeviceShim: typeof AgentDeviceShim.ensureAgentDeviceShim;
  readonly bindAgentDeviceLauncher?: (
    input: Parameters<typeof AgentDeviceShim.ensureAgentDeviceShim>[0] & BoundTarget,
  ) => ReturnType<typeof AgentDeviceShim.ensureAgentDeviceShim>;
  readonly pruneAgentDeviceLaunchers?: (input: {
    readonly stateDir: string;
    readonly live: ReadonlySet<string>;
  }) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
} = AgentDeviceShim;
type MakeWithHosts = typeof DeviceService.makeWithHosts;
const makeWithHosts: (
  hosts: Parameters<MakeWithHosts>[0],
  testHost: Parameters<MakeWithHosts>[1],
  configureAgent: Parameters<MakeWithHosts>[2],
  installTool: Parameters<MakeWithHosts>[3],
  launchers?: Launchers,
) => ReturnType<MakeWithHosts> = DeviceService.makeWithHosts;

/** T3's device tools for one sample. `cwd` names the home that T3's state lives under. */
export const makeDeviceTools = Effect.fn("evaluateMcpToolUse.makeDeviceTools")(function* (
  world: DeviceWorld,
  environment: { readonly cwd: string; readonly platform: string },
) {
  const home = /^\/(?:home|Users)\/[^/]+/.exec(environment.cwd)?.[0] ?? "/home/user";
  for (const id of Object.keys(world.agentDeviceSessions ?? {})) {
    if (!world.devices.some((device) => device.id === id)) {
      return yield* Effect.die(new Error(`world.agentDeviceSessions names no device ${id}.`));
    }
  }
  // T3 names each thread's session on a device; another thread's is named the same way.
  const owners: Array<AgentDeviceOwner> = [];
  for (const [deviceId, threadId] of Object.entries(world.deviceOwners ?? {})) {
    const device = world.devices.find((candidate) => candidate.id === deviceId);
    if (device === undefined) {
      return yield* Effect.die(new Error(`world.deviceOwners names no device ${deviceId}.`));
    }
    const session = yield* agentDeviceSession(threadId, device.hostId, deviceId);
    owners.push({ deviceId, threadId, session });
  }
  const config = ServerConfig.layerTest(environment.cwd, `${home}/.t3`);
  const files = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.void,
    chmod: () => Effect.void,
  });
  const devices = Layer.effect(
    DeviceService.DeviceService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const agentEntry = path.join(home, ".t3", "tools", "agent-device", "bin", "agent-device.mjs");
      const hosts = new Map<DeviceHostId, DeviceHost.DeviceHost["Service"]>([
        [
          LOCAL_DEVICE_HOST_ID,
          fakeHost(world, LOCAL_DEVICE_HOST_ID, LOCAL_DEVICE_HOST_LABEL, agentEntry),
        ],
      ]);
      // Hosts with devices, then configured hosts that may have none, such as a failed one.
      for (const id of [
        ...world.devices.map((device) => device.hostId),
        ...Object.keys(world.deviceHosts ?? {}),
        ...Object.keys(world.deviceDiscoveryFailures ?? {}),
      ]) {
        const label = world.deviceHosts?.[id];
        if (hosts.has(id)) continue;
        if (label === undefined) {
          return yield* Effect.die(new Error(`world.deviceHosts has no label for ${id}.`));
        }
        hosts.set(id, fakeHost(world, id, label, agentEntry));
      }
      // As DeviceService.make, minus writing the config file the path names.
      const configureAgent = (hostId: DeviceHostId, _endpoint: unknown, deviceId?: string) =>
        agentDeviceConfigPath(stateDir, hostId, path, deviceId).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new DeviceOperationError({
                operation: "configure agent",
                reason: "settings_failed",
                cause,
              }),
          ),
        );
      const withFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const { bindAgentDeviceLauncher: bind, pruneAgentDeviceLaunchers: prune } = launcherApi;
      const launchers: Launchers | undefined =
        bind && prune
          ? {
              bind: (input) =>
                AgentDeviceShim.ensureAgentDeviceShim({ entryPath: agentEntry, stateDir }).pipe(
                  Effect.andThen(bind({ entryPath: agentEntry, stateDir, ...input })),
                  withFiles,
                  Effect.mapError(
                    (cause) =>
                      new DeviceOperationError({
                        operation: "bind agent launcher",
                        reason: "command_failed",
                        cause,
                      }),
                  ),
                ),
              prune: (live) => withFiles(prune({ stateDir, live })),
            }
          : undefined;
      const service = yield* makeWithHosts(hosts, undefined, configureAgent, undefined, launchers);
      return DeviceService.DeviceService.of({
        ...service,
        // Older refs install the CLI through agentCli; makeWithHosts has none to install.
        ...("agentCli" in service ? { agentCli: Effect.succeed(agentEntry) } : {}),
        list: failing(service.list),
        open: Effect.fn("DeviceService.DeviceService.open")((input, context) =>
          failing(service.open(input, context)),
        ),
        screenshot: Effect.fn("DeviceService.DeviceService.screenshot")((input) =>
          failing(service.screenshot(input)),
        ),
        close: Effect.fn("DeviceService.DeviceService.close")((input) =>
          failing(service.close(input)),
        ),
      });
    }),
  );
  const context = yield* Layer.build(
    McpHttpServer.layerDeviceToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(devices),
      Layer.provideMerge(
        Layer.mergeAll(
          liveThreadsLayer,
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          ServerSettingsService.layerTest({
            enableDeviceSupport: true,
            enableAgentDeviceAccess: world.deviceAgentAccess !== false,
            deviceOnboardingCompleted: true,
          }),
        ),
      ),
      Layer.provideMerge(config),
      Layer.provideMerge(files),
    ),
  );
  type Entry = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];
  // The registry keeps each tool's handler; its public type lists only definitions.
  const tools = Context.get(context, McpServer.McpServer).tools as ReadonlyArray<Entry>;
  // The testkit's live thread runs on the `codex` instance; the caller must match it.
  const scope: McpInvocationContext.McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("00000000-0000-4000-8000-0000000000e0"),
    requestNamespace: "mcp-tool-use-eval",
    thread: {
      threadId: ThreadId.make("mcp-tool-use-eval"),
      providerSessionId: "mcp-tool-use-eval",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    // A thread holds `device` when agent device access was on as its session started.
    capabilities: new Set<McpInvocationContext.McpCapability>(
      world.deviceAgentAccess === false ? [] : ["device"],
    ),
    issuedAt: 0,
  };
  const request = McpSchema.McpRequestContext.of({
    clientId: 0,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
  });
  const launchers: Array<string> = [];
  const targets: Array<LauncherTarget> = [];
  const call = Effect.fn("evaluateMcpToolUse.deviceCall")(function* (
    name: string,
    input: unknown,
    failure?: DeviceError,
  ) {
    const entry = tools.find((tool) => tool.tool.name === name);
    if (entry === undefined) return yield* Effect.die(new Error(`T3 has no device tool ${name}.`));
    const result = yield* entry.handle(input).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpRequestContext, request),
      Effect.provideService(HostProcess.ExecutablePath, NODE),
      Effect.provideService(HostProcess.Platform, environment.platform as NodeJS.Platform),
      Effect.provideService(Injected, failure),
      // T3 logs each failed screenshot; the result already says so.
      Effect.provideService(References.MinimumLogLevel, "Error"),
      // An MCP client shows a protocol error, such as bad parameters, as the tool's error.
      Effect.catch((error) =>
        Effect.succeed(
          new McpSchema.CallToolResult({
            isError: true,
            content: [{ type: "text", text: error.message }],
          }),
        ),
      ),
    );
    if (!("content" in result)) return yield* Effect.die(new Error(`${name} asked for input.`));
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    // McpServer turns a defect into this text; here a defect is a bug in the eval's world.
    if (text === "Tool execution failed due to an internal server error.") {
      return yield* Effect.die(new Error(`${name} hit a defect in T3 or the eval's world.`));
    }
    const opened = result.structuredContent;
    if (name === "device_open" && !result.isError && isOpened(opened)) {
      const { command, targetArgs = [], session: bound } = opened.agentDevice;
      launchers.push(command);
      // Both refs return the session in the target flags; a bound launcher also names it.
      const flag = targetArgs.indexOf("--session");
      const session = bound ?? (flag < 0 ? undefined : targetArgs[flag + 1]);
      const { device } = opened;
      if (session !== undefined && device !== undefined)
        targets.push({
          command,
          session,
          bound: bound !== undefined,
          deviceId: device.id,
          ios: device.platform === "ios",
          iosSimulator: device.platform === "ios" && !device.physical,
        });
    }
    return { text, isError: result.isError === true };
  });
  const sessions = (history: ReadonlyArray<ShellCall>) =>
    agentDeviceSessions(targets, world.agentDeviceSessions, history, owners);
  /** A device as the simulator knows it from the world: its name, id and host. */
  const deviceName = (deviceId: string) => {
    const device = world.devices.find((candidate) => candidate.id === deviceId);
    if (device === undefined) return deviceId;
    const host =
      device.hostId === LOCAL_DEVICE_HOST_ID
        ? LOCAL_DEVICE_HOST_LABEL
        : (world.deviceHosts?.[device.hostId] ?? device.hostId);
    return `${device.name}, ${device.id}, on ${host}`;
  };
  const launcherText = (command: string) => {
    const target = targets.findLast((candidate) => candidate.command === command);
    if (target === undefined) return command;
    return target.bound
      ? `${command} (drives ${deviceName(target.deviceId)}, in session ${target.session})`
      : `${command} (shared: each command's --udid or --serial and --session name its device and session)`;
  };
  const describe = (history: ReadonlyArray<ShellCall>, command: string | undefined) => {
    const followed = followSessions(targets, world.agentDeviceSessions, history, owners);
    const sessionDevices = new Map([
      ...targets.map((target) => [target.session, deviceName(target.deviceId)] as const),
      ...owners.map((owner) => [owner.session, deviceName(owner.deviceId)] as const),
    ]);
    // Code, not the simulator, decides which of the call's opens another thread's session refuses.
    const opens =
      command === undefined || owners.length === 0
        ? []
        : opensIn(targets, followed, command, owners).flatMap(({ call, words, owner, held }) => {
            const opened = `\`${words.join(" ")}\` drives ${deviceName(call.deviceId)}`;
            const error = owner && inUseError(call, owner);
            if (owner !== undefined && error !== undefined)
              return [
                `${opened}, which session ${owner.session} holds: it fails with exit code 1, printing "Error (${error.code}): ${error.message}" and "Hint: ${error.hint}"`,
              ];
            return held
              ? []
              : [`${opened}, which no other session holds: it prints no DEVICE_IN_USE`];
          });
    return [
      ...(launchers.length > 0
        ? [
            `agent-device launchers T3's device_open returned: ${[...new Set(launchers)].map(launcherText).join("; ")}`,
          ]
        : []),
      ...(followed.sessions.size > 0
        ? [
            `Their agent-device sessions: ${describeSessions(followed.sessions, owners, sessionDevices)}.`,
          ]
        : []),
      ...(opens.length > 0 ? [`In the new call, ${[...new Set(opens)].join("; ")}.`] : []),
    ];
  };
  return {
    call,
    launchers,
    owners,
    sessions,
    sessionError: (history, command) => {
      const error = agentDeviceSessionError(targets, sessions(history), command, owners);
      return error && agentDeviceError(home, error.session, `${history.length}\n${command}`, error);
    },
    describe,
  } satisfies DeviceTools;
});

const isOpened = Schema.is(
  Schema.Struct({
    device: Schema.optional(
      Schema.Struct({ id: Schema.String, platform: Schema.String, physical: Schema.Boolean }),
    ),
    agentDevice: Schema.Struct({
      command: Schema.String,
      targetArgs: Schema.optional(Schema.Array(Schema.String)),
      session: Schema.optional(Schema.String),
    }),
  }),
);
