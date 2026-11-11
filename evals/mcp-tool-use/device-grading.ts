import * as Schema from "effect/Schema";

export const DeviceExpect = Schema.Struct({
  briefs: Schema.optional(Schema.Number),
  recording: Schema.optional(Schema.String),
  artifact: Schema.optional(Schema.String),
  noRawUi: Schema.optional(Schema.Boolean),
  capture: Schema.optional(
    Schema.Struct({
      hostId: Schema.String,
      deviceId: Schema.String,
      app: Schema.optional(Schema.String),
    }),
  ),
  noShutdown: Schema.optional(
    Schema.Array(Schema.Struct({ hostId: Schema.String, deviceId: Schema.String })),
  ),
  report: Schema.optional(Schema.Array(Schema.String)),
  reportOrCapture: Schema.optional(Schema.Boolean),
  maxFailedAttemptsPerTurn: Schema.optional(Schema.Number),
  maxCaptureAttempts: Schema.optional(Schema.Number),
});

type DeviceRun = {
  readonly launchers?: ReadonlyArray<string>;
  readonly text?: string;
  readonly finalText?: string;
  readonly stopReason?: string;
  readonly transcript?: ReadonlyArray<unknown>;
  readonly calls: ReadonlyArray<{
    readonly step: number;
    readonly tool: string;
    readonly input: unknown;
    readonly turn?: number;
    readonly failed?: boolean;
    readonly output?: string;
  }>;
};
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const inputString = (input: unknown, key: string) =>
  record(input) && typeof input[key] === "string" ? input[key] : "";
const resultTarget = (call: DeviceRun["calls"][number]) => {
  try {
    const device: unknown = JSON.parse(call.output ?? "").device;
    if (record(device) && typeof device.hostId === "string" && typeof device.id === "string")
      return { hostId: device.hostId, deviceId: device.id };
  } catch {}
};
const inputTarget = (call: DeviceRun["calls"][number]) => ({
  hostId: inputString(call.input, "hostId") || "local",
  deviceId: inputString(call.input, "deviceId"),
});
const openTargets = (previous: DeviceRun["calls"]) => {
  const sessions = new Map<string, ReturnType<typeof inputTarget>>();
  for (const prior of previous) {
    if (prior.failed !== false) continue;
    if (prior.tool === "device_open") {
      const target = resultTarget(prior) ?? inputTarget(prior);
      const key = `${target.hostId}/${target.deviceId}`;
      sessions.delete(key);
      sessions.set(key, target);
    } else if (prior.tool === "device_close") {
      const host = inputString(prior.input, "hostId"),
        id = inputString(prior.input, "deviceId");
      for (const [key, target] of sessions)
        if ((!host || target.hostId === host) && (!id || target.deviceId === id))
          sessions.delete(key);
    }
  }
  return [...sessions.values()];
};
const flagValue = (words: ReadonlyArray<string>, flag: string) => {
  for (const [i, word] of words.entries()) {
    if (i === 0) continue;
    if (word === flag) return words[i + 1];
    if (word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
  }
};
/** Each successful device_open's launcher, with the device and session it targets. */
const launcherOpens = (previous: DeviceRun["calls"]) =>
  previous.flatMap((call) => {
    if (call.tool !== "device_open" || call.failed !== false) return [];
    try {
      const { device, agentDevice }: Record<string, unknown> = JSON.parse(call.output ?? "");
      if (
        !record(device) ||
        !record(agentDevice) ||
        typeof device.hostId !== "string" ||
        typeof device.id !== "string" ||
        typeof agentDevice.command !== "string"
      )
        return [];
      const targetArgs = Array.isArray(agentDevice.targetArgs)
        ? agentDevice.targetArgs.filter((arg): arg is string => typeof arg === "string")
        : [];
      const session =
        typeof agentDevice.session === "string"
          ? agentDevice.session
          : flagValue(["", ...targetArgs], "--session");
      return [
        { command: agentDevice.command, hostId: device.hostId, deviceId: device.id, session },
      ];
    } catch {
      return [];
    }
  });
/**
 * The device a launcher command drives: the one its --udid, --serial or --session names among
 * the devices its launcher was returned for, else its launcher's only device. Without launcher
 * results, only the sole open device.
 */
const launcherTarget = (words: ReadonlyArray<string>, previous: DeviceRun["calls"]) => {
  const id = flagValue(words, "--udid") ?? flagValue(words, "--serial");
  const session = flagValue(words, "--session");
  const launched = launcherOpens(previous).filter((open) => open.command === words[0]);
  const candidates = (
    launched.length > 0
      ? launched
      : openTargets(previous).map((t) => ({ ...t, session: undefined }))
  ).filter(
    (t) =>
      (id === undefined || t.deviceId === id) &&
      (session === undefined || t.session === undefined || t.session === session),
  );
  return new Set(candidates.map((t) => `${t.hostId}/${t.deviceId}`)).size === 1
    ? candidates.at(-1)
    : undefined;
};
const screenshotTarget = (call: DeviceRun["calls"][number], previous: DeviceRun["calls"]) => {
  const result = resultTarget(call);
  if (result) return result;
  if (call.failed && /open in this thread/.test(call.output ?? "")) return undefined;
  const host = inputString(call.input, "hostId"),
    id = inputString(call.input, "deviceId");
  if (host && id) return inputTarget(call);
  const matches = openTargets(previous).filter(
    (t) => (!host || t.hostId === host) && (!id || t.deviceId === id),
  );
  return id ? matches.at(-1) : matches.length === 1 ? matches[0] : undefined;
};
const managed =
  /device_(?:open|screenshot|action)\b|device (?:panel|manager|tools)|returned\s+(?:(?:bound|pinned|agent-device|cli)\s+)*(?:launcher|driver|command)/;
const ui =
  /\b(?:ui|screens?|screenshots?|screen captures?|record(?:ing|video)?s?|settings|taps?|typ(?:e|ing)|launch(?:es|ing)?|relaunch(?:es|ing)?|deep links?|swipes?|simulator (?:control|actions)|device actions|(?:drive|control|inspect)\s+(?:the\s+)?(?:simulator|device|app))\b/;
const rawCommand =
  /\bsimctl\s+(?:launch|terminate|openurl|ui|privacy|location|push)\b|\bsimctl\s+io\s+(?:[^\s;]+\s+)?(?:screenshot|recordvideo)\b|\bidb\b[^.;]*\b(?:ui|screenshot|launch|video|record)\b|\badb\b[^.;]*\b(?:input|screencap|screenrecord)\b|\blab-(?:shot|ui|launch|capture(?:-set)?)\b|\bmac_agent_device\b/;

export function briefRoute(text: string) {
  const positive = text
    .toLowerCase()
    .replaceAll("’", "'")
    .replace(/[`*]/g, "")
    // "SSH for the non-UI operations" restricts SSH rather than routing UI through it.
    .replace(/\bnon-(?:ui|device|simulator|screen)\b/g, "auxiliary")
    // A trailing prohibition negates its subject, not an earlier independent predicate.
    .replace(
      /(^|[.;\n]\s*)((?:-\s*)?(?:use|capture|take|record|run|call|drive)\b[^.;,\n]*?)\s+and\s+(?=[^.;,\n]*?\b(?:is|are)\s+(?:strictly\s+)?(?:forbidden|prohibited|disallowed|banned|not allowed|not permitted)\b)/g,
      "$1$2. ",
    )
    .replace(
      /\b(?!(?:because|since|as|if|unless|when|so|but)\b)(?:(?!\b(?:because|since|as|if|unless|when|so|but)\b)[^.;,\n])*?\b(?:is|are)\s+(?:strictly\s+)?(?:forbidden|prohibited|disallowed|banned|not allowed|not permitted)\b/g,
      "",
    )
    .replace(/\b(?:do not|don't)\s+forget\s+to\b/g, "")
    .replace(/\b(?:do not|don't)\s+avoid\b/g, "use")
    .replace(/\b(?:should|must)\s+not\s+be\s+avoided\b/g, "is allowed")
    .replace(/\b(?:there is )?no need to avoid\b/g, "use")
    .replace(/\bnot just\b/g, "")
    .replace(/\bbut (?:also )?for\b/g, "and for")
    .replace(/\bavoid limiting (ssh|simctl|adb|idb) to [^.;]+;\s*use it\b/g, "use $1")
    .replace(/(^|[.!;\n]\s*)(for [^.;,\n]+),\s*(?=(?:use|run)\b)/g, "$1$2 ")
    .split(
      /[\n.!;]+(?=\s|$)|\b(?:but|however|while)\b|,\s*(?=(?:screenshots?|recordings?)\s+(?:via|through|go))|(?:,\s*|\band\s+|\bthen\s+)(?=(?:use|run|call)\b)/,
    )
    .map((clause) =>
      (
        clause.split(
          /\b(?:not|never|no|don't|cannot|can't|avoid|forbidden|prohibited|disallowed|rather than|instead of|without)\b/,
        )[0] ?? ""
      )
        .replace(
          /\b(?:ui|screen|settings|simulator|device|app)\s+(logs?|builds?|test runners?)\b/g,
          "$1",
        )
        .replace(/\b(?:record|capture|stream)\s+(?:the\s+)?logs\b/g, "logs")
        .replace(/\b(?:logs? from|reading)\s+screenshot\s+(?:tests?|logs?)\b/g, "logs")
        .replace(
          /\b(?:copy(?:ing)?|fetch(?:ing)?|transfer(?:ring)?|download(?:ing)?|sync(?:ing)?)\s+(?:(?:the|already|saved)\s+)*(?:screenshots?|recordings?|artifacts?)\b/g,
          "artifact transfer",
        ),
    );
  const hasManaged = positive.some((clause) => managed.test(clause));
  const hasRaw = positive.some((clause) => {
    if (rawCommand.test(clause)) return true;
    const routes = clause.matchAll(/\b(?:ssh|simctl|idb|adb|lab scripts?)\b/g);
    for (const route of routes) {
      const before = clause.slice(0, route.index);
      const after = clause.slice(route.index + route[0].length).split(managed)[0] ?? "";
      // Copying already-saved artifacts is auxiliary; keep later capture verbs visible.
      const copies =
        /^\s+(?:to\s+)?(?:copy|fetch|transfer|download|sync)\b/.test(after) ||
        /\b(?:copy|fetch|transfer|download|sync)\s+(?:(?:the|saved)\s+)*(?:screenshots?|recordings?|artifacts?)\s+(?:over|via|through|using)\s*$/.test(
          before,
        );
      if (copies && !/\b(?:take|capture|inspect|record|drive|control)\b/.test(after)) continue;
      const purpose =
        /^\s+(?:(?:is|are|can|may|must|should|be|used|only|allowed|permitted|fine)\s+)*(?:for|to|into)\b/.test(
          after,
        );
      const hostPurpose =
        /^\s+(?:-\S+\s+\S+\s+)*\S+\s+(?:for|and|then)\b|^\s+(?:handles|and|then)\b/.test(after);
      if ((purpose || hostPurpose || new RegExp(`^\\s+${ui.source}`).test(after)) && ui.test(after))
        return true;
      const via = new RegExp(
        `${ui.source}(?:\\s+(?:may|can|must|should|be|is|are|taken|captured|saved|recorded|only|directly))*\\s+(?:via|by|over|through|using|with|use|run)\\s+(?:raw\\s+)?$`,
      );
      if (
        via.test(before) ||
        /\b(?:screenshots?|screen(?: capture)?|recordings?)(?:\s+on\s+\S+)?\s+(?:over|via|using|through|with)\s*$/.test(
          before,
        ) ||
        /\bfor\s+[^.;]*\b(?:screenshots?|recordings?|screen capture)\s*,?\s*$/.test(before)
      )
        return true;
    }
    return false;
  });
  return hasManaged && hasRaw ? "mixed" : hasManaged ? "managed" : hasRaw ? "raw" : "neutral";
}

const executable = (word = "") => word.split("/").at(-1) ?? "";
const uiCommand =
  /^(?:simctl\s+(?:launch|terminate|openurl|ui|privacy|location|push)\b|simctl\s+io\s+\S+\s+(?:screenshot|recordvideo)\b|idb\b.*\b(?:ui|screenshot|launch|video|record)\b|adb\b.*\b(?:shell\s+(?:input|am\s+start|settings)|(?:shell|exec-out)\s+(?:screencap|screenrecord))\b|screencapture\b|lab-(?:shot|ui|launch|capture(?:-set)?)\b)/i;
const deviceArgs = (words: ReadonlyArray<string>) => {
  const args: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") return [...args, ...words.slice(i + 1)];
    if (!word.startsWith("-")) args.push(word);
    else if (
      /^--(?:platform|udid|serial|device|target|level|config|remote-config|session|state-dir|scope|timeout|timeout-ms|wait|metro-port|out|quality)$/.test(
        word,
      )
    )
      i++;
  }
  return args;
};
const auxiliaryAgent =
  /^(?:(?:devices|apps|doctor|capabilities|install|uninstall|reinstall|install-from-source|logs|help|version)(?: |$)|session list(?: |$)|record contact-sheet(?: |$))/;
const deviceOperation = (words: ReadonlyArray<string>) => {
  const args = deviceArgs(words);
  return !!args[0] && !auxiliaryAgent.test(args.join(" "));
};
const interpreter = /^(?:python\d*(?:\.\d+)?|node|ruby|perl|osascript)$/;
const shells = new Set(["bash", "sh", "zsh"]);
/** Human and JSON agent-device failure envelopes. */
const AGENT_DEVICE_ERROR = /\bError \([A-Z_]+\):|"success"\s*:\s*false/;

export type ShellInvocation = {
  readonly words: ReadonlyArray<string>;
  readonly remote: boolean;
  readonly raw: boolean;
  readonly managed: boolean;
  /** Raw-route checks inspect possible actions; managed credit requires established execution. */
  readonly executed: boolean;
  /** An aggregate success cannot establish success of an action masked by ||. */
  readonly unmasked: boolean;
  /** A later `;` or `&` command owns the call's exit status. */
  readonly sequenced: boolean;
};

// A deliberately bounded shell grammar, not a shell executor. Keep quotes until expansion so
// literal command examples, comments and quoted heredocs never become invocations.
const tokens = (source: string) =>
  source
    .replace(/'[^']*'|\\[\s\S]/g, (part) => (part === "\\\n" ? "" : part))
    .match(
      /`(?:\\.|[^`])*`|[<>]\((?:[^()]|\([^()]*\))*\)|\$\((?:[^()'"\\]|\\.|'[^']*'|"(?:\\.|[^"\\])*"|\([^()]*\))*\)|\d+(?:>>?|<)(?:&\d+)?|(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|\$\{\w+\}|[^\s;&|(){}<>"'\\])+|&&|\|\||[;\n&|(){}]|\d*(?:>>?|<)(?:&\d+)?/g,
    ) ?? [];
const unquote = (word: string, variables: Map<string, string>) =>
  word.replace(
    /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)|([^'"\\]+)/g,
    (
      _part,
      single: string | undefined,
      double: string | undefined,
      escaped: string | undefined,
      plain: string | undefined,
    ) => {
      if (single !== undefined) return single;
      if (escaped !== undefined) return escaped;
      return (double ?? plain ?? "").replace(
        /\\(["\\$])|\$(?:\{(\w+)\}|(\w+))/g,
        (ref, escaped: string | undefined, braced: string | undefined, bare: string | undefined) =>
          escaped ?? variables.get(braced ?? bare ?? "") ?? ref,
      );
    },
  );

function unwrap(words: string[]) {
  while (words.length) {
    if (/^\w+=/.test(words[0]!)) {
      words.shift();
      continue;
    }
    const name = executable(words[0]);
    if (!/^(?:env|sudo|command|nohup|exec|time|caffeinate|timeout|nice)$/.test(name)) break;
    words.shift();
    const takesValue: Record<string, RegExp> = {
      env: /^(?:-u|--unset|-C|--chdir)$/,
      sudo: /^(?:-[ughpCT]|--user|--group|--host|--prompt)$/,
      caffeinate: /^-[tw]$/,
      timeout: /^(?:-[sk]|--signal|--kill-after)$/,
      nice: /^(?:-n|--adjustment)$/,
    };
    while (words[0]?.startsWith("-")) {
      const option = words.shift()!;
      if (option === "--") break;
      if (takesValue[name]?.test(option)) words.shift();
    }
    if (name === "timeout") words.shift();
  }
  return words;
}

/** Literal process-launch APIs only. Definitions and strings are not executed programs. */
function scriptInvocations(
  script: string,
  remote: boolean,
  variables: Map<string, string>,
  language: string,
): ShellInvocation[] {
  const actions: ShellInvocation[] = [];
  const python = language.startsWith("python");
  // A function body is source, not an invocation. Calls to computed/script functions are
  // outside this grammar; do not grant managed credit for them.
  let definitionIndent: number | undefined;
  if (python)
    script = script
      .split("\n")
      .map((line) => {
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        if (line.trim() && definitionIndent !== undefined && indent <= definitionIndent)
          definitionIndent = undefined;
        if (/^\s*(?:async\s+)?def\s/.test(line)) definitionIndent = indent;
        return definitionIndent === undefined ? line : "";
      })
      .join("\n");
  const launch =
    /^(subprocess\.(?:run|Popen|call|check_call|check_output)|os\.(?:system|popen)|(?:child_process\.)?(?:execFileSync|execFile|execSync|exec|spawnSync|spawn))\s*\(/;
  const literal = "(?:'[^']*'|\"(?:\\\\.|[^\"\\\\])*\")";
  const quoteArg = (arg: string) => `'${unquote(arg, variables).replaceAll("'", "'\\''")}'`;
  const array = (source: string) => {
    const match = new RegExp(`^\\[\\s*(${literal}(?:\\s*,\\s*${literal})*\\s*,?)?\\s*\\]`).exec(
      source,
    );
    return match
      ? (match[1]?.match(new RegExp(literal, "g")) ?? []).map(quoteArg).join(" ")
      : undefined;
  };
  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    if (char === "#" || script.slice(i, i + 2) === "//") {
      const end = script.indexOf("\n", i);
      i = end < 0 ? script.length : end;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = python && script.slice(i, i + 3) === char.repeat(3) ? char.repeat(3) : char;
      i += quote.length;
      while (i < script.length && script.slice(i, i + quote.length) !== quote) {
        if (script[i] === "\\") i++;
        i++;
      }
      i += quote.length - 1;
      continue;
    }
    const match = launch.exec(script.slice(i));
    if (!match) continue;
    const rest = script.slice(i + match[0].length).trimStart();
    let program: string | undefined;
    if (rest.startsWith("[")) program = array(rest);
    else {
      const arg = rest.match(new RegExp(`^${literal}`))?.[0];
      const tail = arg === undefined ? "" : rest.slice(arg.length);
      if (arg && /(?:spawn|execFile)/.test(match[1]!)) {
        const argv = array(tail.replace(/^\s*,\s*/, ""));
        if (argv !== undefined) program = `${quoteArg(arg)} ${argv}`;
      } else if (
        arg &&
        (!python || match[1]!.startsWith("os.") || /^\s*,[^)]*\bshell\s*=\s*True\b/.test(tail))
      ) {
        program = unquote(arg, variables);
      }
    }
    if (program !== undefined) {
      const line = script.slice(script.lastIndexOf("\n", i) + 1, i);
      const boundary = Math.max(
        script.lastIndexOf(";", i),
        python ? script.lastIndexOf("\n", i) : -1,
      );
      const statement = script.slice(boundary + 1, i);
      const certain =
        !/=>|\bfunction\b|\blambda\b/.test(statement) &&
        (python ? !/^\s/.test(line) : !script.slice(0, i).includes("{"));
      actions.push(
        ...shellInvocations(program, new Map(variables), remote).map((action) => ({
          ...action,
          executed: action.executed && certain,
          // A script's exit status needn't reflect its subprocesses (`subprocess.run` doesn't check).
          sequenced: true,
        })),
      );
    }
    i += match[0].length - 1;
  }
  return actions;
}

/** Shared by raw-UI, recording and failure grading. Literal aliases may span shell calls. */
export function shellInvocations(
  command: string,
  variables = new Map<string, string>(),
  remote = false,
  succeeded = false,
  /** Shared with function calls: the shell's functions, and whether it exited. */
  shell: {
    functions: Map<string, { text: string; certain: boolean }>;
    exited: boolean;
    depth: number;
  } = {
    functions: new Map(),
    exited: false,
    depth: 0,
  },
): ShellInvocation[] {
  if (shell.depth > 8) return [];
  const bodies = new Map<string, { text: string; expand: boolean }>();
  command = command.replace(
    /^([^\n]*?)<<(-?)\s*(['"]?)(\w+)\3([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\4[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm,
    (
      _match,
      line: string,
      strip: string,
      quote: string,
      _end: string,
      rest: string,
      body: string,
    ) => {
      const key = `__HEREDOC_${bodies.size}`;
      bodies.set(key, { text: strip ? body.replace(/^\t+/gm, "") : body, expand: !quote });
      return `${line} ${key} ${rest}`;
    },
  );
  const actions: ShellInvocation[] = [];
  let clause: string[] = [];
  let pipe: string | undefined;
  let gate = "";
  let status: boolean | undefined;
  // `before` says whether an earlier if/elif branch of this statement ran: true, false or unknown.
  const conditions: Array<{
    parent: boolean;
    certain: boolean;
    take: boolean | undefined;
    before: boolean | undefined;
  }> = [];
  let active = true;
  let certain = true;
  let currentCertain = true;
  let currentUnmasked = true;
  let currentSequenced = false;
  // After a certain `exit` or `return`, nothing later in its scope runs.
  let exited = false;
  const append = (nested: ShellInvocation[]) =>
    actions.push(
      ...nested.map((action) => ({
        ...action,
        executed: action.executed && currentCertain,
        unmasked: action.unmasked && currentUnmasked,
        sequenced: action.sequenced || currentSequenced,
      })),
    );
  const truth = (words: string[]): boolean | undefined => {
    if (words[0] === "!") {
      const value = truth(words.slice(1));
      return value === undefined ? undefined : !value;
    }
    return ["true", ":"].includes(words[0] ?? "") ? true : words[0] === "false" ? false : undefined;
  };
  const commandTokens = tokens(command.replace(/(^|\n)[ \t]*#[^\n]*/g, "$1"));
  let tokenIndex = 0;
  const functions = shell.functions;
  const listTokens = () => {
    let start = tokenIndex - 1,
      end = tokenIndex;
    while (start >= 0 && !/^[;\n&]$/.test(commandTokens[start]!)) start--;
    while (end < commandTokens.length && !/^[;\n&]$/.test(commandTokens[end]!)) end++;
    return commandTokens.slice(start + 1, end);
  };
  const substitutions = (source: string, heredoc = false) => {
    const expanded = heredoc
      ? source
      : source.replace(
          /"((?:\\.|[^"\\])*)"|'[^']*'|\\./g,
          (part, double: string | undefined) => double ?? (part.startsWith("'") ? "" : part),
        );
    for (const match of expanded.matchAll(/(?<!\\)\$\(((?:[^()]|\([^()]*\))*)\)/g))
      append(shellInvocations(match[1]!, new Map(variables), remote));
    for (const match of expanded.matchAll(/(?<!\\)`([^`]*)`|[<>]\(((?:[^()]|\([^()]*\))*)\)/g))
      append(shellInvocations(match[1] ?? match[2]!, new Map(variables), remote));
  };
  const flush = () => {
    if (!clause.length) return;
    const rawWords = clause;
    const redirects = redirectOperands;
    redirectOperands = [];
    clause = [];
    let words = rawWords.map((word) => unquote(word, variables));
    if (words[0] === "if") {
      const parent = active;
      conditions.push({
        parent,
        certain,
        take: undefined,
        before: false,
      });
      words.shift();
    }
    if (words[0] === "then") {
      const condition = conditions.at(-1);
      // The branch follows the condition list's final status (`if true && false`), not its
      // first command's.
      if (condition) condition.take = condition.before === true ? false : status;
      active =
        condition?.parent !== false && condition?.take !== false && condition?.before !== true;
      certain =
        condition?.certain !== false && condition?.take === true && condition?.before === false;
      words.shift();
    }
    if (words[0] === "else") {
      const condition = conditions.at(-1);
      active = !!condition?.parent && condition.take !== true && condition.before !== true;
      certain = !!condition?.certain && condition.take === false && condition.before === false;
      words.shift();
    }
    if (words[0] === "fi") {
      const condition = conditions.pop();
      active = condition?.parent ?? true;
      certain = condition?.certain ?? true;
      words.shift();
    }
    if (words[0] === "elif") {
      // An elif's condition runs only when no earlier branch did.
      const condition = conditions.at(-1);
      if (condition) {
        condition.before =
          condition.before === true || condition.take === true
            ? true
            : condition.before === false && condition.take === false
              ? false
              : undefined;
        condition.take = condition.before === true ? false : truth(words.slice(1));
        active = condition.parent && condition.before !== true;
        certain = condition.certain && condition.before === false;
      }
      words.shift();
    }
    const loopList = /^(?:for|select)$/.test(words[0] ?? "");
    if (/^(?:while|until)$/.test(words[0] ?? "") || loopList) {
      const value = loopList
        ? words[2] === "in" && words.length > 3
          ? true
          : undefined
        : truth(words.slice(1));
      conditions.push({
        parent: active,
        certain,
        take: words[0] === "until" && value !== undefined ? !value : value,
        before: false,
      });
      if (!loopList) words.shift();
    }
    if (words[0] === "do") {
      const condition = conditions.at(-1);
      active = condition?.parent !== false && condition?.take !== false;
      certain = condition?.certain !== false && condition?.take === true;
      words.shift();
    }
    if (words[0] === "done") {
      const condition = conditions.pop();
      active = condition?.parent ?? true;
      certain = condition?.certain ?? true;
      words.shift();
    }
    const reachable =
      gate === "&&" ? status : gate === "||" ? (status === undefined ? undefined : !status) : true;
    if (!active || exited || !words.length || reachable === false) return;
    const list = listTokens();
    currentUnmasked = !list.includes("||") && words[0] !== "!";
    // The call's exit status is the last command's; an action followed by `;` or `&` doesn't own it.
    // A command piped into another doesn't own the pipeline's status either.
    currentSequenced =
      commandTokens[tokenIndex] === "|" ||
      commandTokens.slice(tokenIndex).some((t) => /^[;\n&]$/.test(t));
    const finalAndSuccess =
      succeeded &&
      gate === "&&" &&
      currentUnmasked &&
      !commandTokens.some((t) => /^(?:if|for|while|until|then|else|fi|do|done)$/.test(t)) &&
      !commandTokens.slice(tokenIndex).some((t) => /^[;\n&]$/.test(t));
    currentCertain = certain && (reachable === true || finalAndSuccess);
    // A list's status is known only when this command certainly ran, or when its own result
    // decides the list either way (`x && false`, `x || true`).
    const value = truth(words);
    status =
      reachable === true
        ? value
        : gate === "&&" && value === false
          ? false
          : gate === "||" && value === true
            ? true
            : undefined;
    for (const word of [...rawWords, ...redirects]) if (!bodies.has(word)) substitutions(word);
    if (loopList) return;
    const body = words.map((word) => bodies.get(word)).find((value) => value !== undefined);
    if (body?.expand) substitutions(body.text, true);
    words = words.filter((word) => !bodies.has(word));
    const literalAssignments = words.every((word) => /^\w+=/.test(word));
    if (literalAssignments || words[0] === "export") {
      for (const word of words) {
        const at = word.indexOf("=");
        if (at > 0) {
          if (currentCertain) variables.set(word.slice(0, at), word.slice(at + 1));
          else variables.delete(word.slice(0, at));
        }
      }
      return;
    }
    if (executable(words[0]) === "command" && /^-[vV]$/.test(words[1] ?? "")) return;
    while (words[0] === "!") words.shift();
    words = unwrap(words);
    if (/^(?:exit|return)$/.test(executable(words[0]))) {
      if (currentCertain) {
        exited = true;
        // `exit` in a function ends the shell; `return` ends only the function.
        if (executable(words[0]) === "exit") shell.exited = true;
      } else certain = false;
      return;
    }
    const name = executable(words[0]);
    let input = body?.text ?? pipe;
    pipe = undefined;
    if (name === "cat" || name === "tee") {
      pipe = input;
      return;
    }
    if (name === "printf" || name === "echo") {
      pipe =
        name === "echo"
          ? words.slice(1).join(" ")
          : words[1]?.includes("%s")
            ? words.slice(2).join("\n")
            : words[1]?.replaceAll("\\n", "\n");
      return;
    }
    if (functions.has(name)) {
      const definition = functions.get(name)!;
      const call = { functions, exited: false, depth: shell.depth + 1 };
      append(
        shellInvocations(definition.text, new Map(variables), remote, succeeded, call).map(
          (action) => ({ ...action, executed: action.executed && definition.certain }),
        ),
      );
      if (call.exited && definition.certain && currentCertain) exited = shell.exited = true;
      return;
    }
    if (name === "ssh") {
      let at = 1;
      while (words[at]?.startsWith("-")) {
        const option = words[at++]!;
        if (option === "--") break;
        if (/^-[bBcDEeFIiJLlmOoPpQRSWw]$/.test(option)) at++;
      }
      at++; // destination
      if (words[at] === "--") at++;
      const script = words.slice(at).join(" ");
      // A remote shell/interpreter inherits redirected/piped stdin, never the local aliases.
      const destination = unwrap(tokens(script).map((word) => unquote(word, new Map())));
      const reader = executable(destination[0]);
      // Shells take a program with -c (`bash -se` reads stdin); interpreters with -c or -e.
      const programFlag = shells.has(reader) ? /^-[a-z]*c[a-z]*$/ : /^-[a-z]*[ce][a-z]*$/;
      const hasProgram = destination.some((word) => programFlag.test(word));
      if (
        input !== undefined &&
        (!reader || ((shells.has(reader) || interpreter.test(reader)) && !hasProgram))
      ) {
        if (interpreter.test(reader)) append(scriptInvocations(input, true, new Map(), reader));
        else append(shellInvocations(input, new Map(), true));
      }
      append(shellInvocations(script, new Map(), true));
      return;
    }
    if (shells.has(name) || interpreter.test(name)) {
      const at = words.findIndex((word) =>
        (shells.has(name) ? /^-[a-z]*c[a-z]*$/ : /^-[a-z]*[ce][a-z]*$/).test(word),
      );
      if (at >= 0) input = words[at + 1];
      if (input !== undefined)
        append(
          shells.has(name)
            ? shellInvocations(input, new Map(variables), remote, succeeded)
            : scriptInvocations(input, remote, variables, name),
        );
      return;
    }
    const endOptions = words.indexOf("--");
    if (
      words
        .slice(0, endOptions < 0 ? words.length : endOptions)
        .some((word) => word === "--help" || word === "-h") ||
      words[1] === "help"
    )
      return;
    const normalized = name === "xcrun" ? words.slice(1) : [...words];
    if (name === "xcrun")
      while (normalized[0]?.startsWith("-")) {
        const option = normalized.shift();
        if (/^(?:--sdk|-sdk|--toolchain|-toolchain)$/.test(option ?? "")) normalized.shift();
      }
    const cli = executable(normalized[0]);
    const agent = ["agent-device", "mac_agent_device"].includes(cli) && deviceOperation(normalized);
    actions.push({
      words,
      remote,
      executed: currentCertain,
      unmasked: currentUnmasked,
      sequenced: currentSequenced,
      raw:
        uiCommand.test([cli, ...normalized.slice(1)].join(" ")) ||
        (agent && (remote || cli === "mac_agent_device")),
      managed: agent && !remote && cli === "agent-device",
    });
  };
  const scopes: Array<{
    variables: Map<string, string>;
    active: boolean;
    certain: boolean;
    exited: boolean;
    subshell: boolean;
  }> = [];
  let comment = false;
  let redirect = false;
  let redirectOperands: string[] = [];
  for (; tokenIndex < commandTokens.length; tokenIndex++) {
    const token = commandTokens[tokenIndex]!;
    // Comments come first, so a commented-out function definition is never registered.
    if (token === "\n") comment = false;
    if (comment) continue;
    if (token.startsWith("#")) {
      comment = true;
      continue;
    }
    // Shell function definitions don't execute their bodies. Keep literal calls supported.
    const nameAt = tokenIndex + (token === "function" ? 1 : 0);
    const bodyAt =
      commandTokens[nameAt + 1] === "(" && commandTokens[nameAt + 2] === ")"
        ? nameAt + 3
        : token === "function"
          ? nameAt + 1
          : -1;
    if (commandTokens[bodyAt] === "{") {
      flush();
      let end = bodyAt + 1,
        depth = 1;
      for (; end < commandTokens.length && depth; end++) {
        if (commandTokens[end] === "{") depth++;
        if (commandTokens[end] === "}") depth--;
      }
      if (active)
        functions.set(commandTokens[nameAt]!, {
          text: commandTokens.slice(bodyAt + 1, end - 1).join(" "),
          certain,
        });
      tokenIndex = end - 1;
      continue;
    }
    if (/^\d*(?:>>?|<)(?:&\d+)?$/.test(token)) {
      redirect = !token.includes("&");
      continue;
    }
    if (redirect) {
      redirect = false;
      redirectOperands.push(token);
      continue;
    }
    if (/^(?:&&|\|\||[;\n&|(){}])$/.test(token)) {
      flush();
      if (token === "(" || token === "{") {
        scopes.push({ variables, active, certain, exited, subshell: token === "(" });
        if (token === "(") variables = new Map(variables);
        const reachable =
          gate === "&&"
            ? status
            : gate === "||"
              ? status === undefined
                ? undefined
                : !status
              : true;
        active = active && reachable !== false;
        certain = certain && reachable === true;
      }
      if (token === ")" || token === "}") {
        const scope = scopes.pop();
        // A subshell's exit ends only the subshell; a group's ends the shell.
        if (scope) exited = scope.exited || (!scope.subshell && exited);
        if (scope) ({ variables, active, certain } = scope);
      }
      if (token !== "|") pipe = undefined;
      gate = token;
    } else clause.push(token);
  }
  flush();
  return actions;
}

export function gradeDevice(expect: typeof DeviceExpect.Type | undefined, run: DeviceRun) {
  const checks: Array<{ check: string; pass: boolean }> = [];
  if (!expect) return checks;
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  if (expect.briefs !== undefined) {
    const briefs = run.calls.filter((call) =>
      ["delegate_task", "t3_thread_launch"].includes(call.tool),
    );
    add("device briefs count", briefs.length >= expect.briefs);
    for (const [i, call] of briefs.entries()) {
      const route = briefRoute(
        inputString(call.input, call.tool === "delegate_task" ? "task" : "message"),
      );
      add(`device brief ${i + 1} ${call.tool} ${route}`, route === "managed");
    }
  }
  if (expect.artifact !== undefined)
    add(
      `device final artifact ${expect.artifact}`,
      run.stopReason === "end_turn" && (run.finalText ?? "").includes(expect.artifact),
    );
  const variables = new Map<string, string>();
  const shell = run.calls
    .filter((call) => ["Bash", "Monitor"].includes(call.tool))
    .map(
      (call) =>
        [
          call,
          shellInvocations(
            inputString(call.input, "command"),
            variables,
            false,
            call.failed === false,
          ).map((action) => ({
            ...action,
            args: deviceArgs(action.words),
            bound: !action.remote && (run.launchers ?? []).includes(action.words[0] ?? ""),
          })),
        ] as const,
    );
  const allActions = shell.flatMap(([, actions]) => actions);
  const usableImage = (call: DeviceRun["calls"][number]) => {
    if (call.failed !== false) return false;
    try {
      const image: unknown = JSON.parse(call.output ?? "").screenshot;
      return (
        record(image) &&
        typeof image.width === "number" &&
        image.width > 0 &&
        typeof image.height === "number" &&
        image.height > 0
      );
    } catch {
      return false;
    }
  };
  const successfulScreenshots = ([call, actions]: (typeof shell)[number]) => {
    const captures = actions.filter((a) => a.managed && a.bound && a.args[0] === "screenshot");
    if (
      call.failed !== false ||
      AGENT_DEVICE_ERROR.test(call.output ?? "") ||
      captures.length !== 1 ||
      /"(?:width|height)"\s*:\s*0\b/.test(call.output ?? "")
    )
      return [];
    const paths = (call.output ?? "").split("\n").flatMap((line) => {
      // The simulated shell words the success line several ways; each must still name the path.
      const saved = line.match(
        /^[^\w\n]*(?:Screenshot saved|Saved screenshot|Captured screenshot|Wrote screenshot)(?: to)?:?\s+(.+)$/i,
      )?.[1];
      if (saved) return [saved];
      try {
        const image: unknown = JSON.parse(line);
        if (
          record(image) &&
          typeof image.path === "string" &&
          typeof image.width === "number" &&
          image.width > 0 &&
          typeof image.height === "number" &&
          image.height > 0
        )
          return [image.path];
      } catch {}
      return [];
    });
    return captures.filter(
      (a) =>
        a.unmasked &&
        ((paths.length === 0 && a.executed && !a.sequenced) ||
          paths.some(
            (path) =>
              path === a.args[1] ||
              (a.args[1]?.startsWith("$/") && path.endsWith(a.args[1].slice(1))),
          )),
    );
  };
  const recovered =
    expect.reportOrCapture &&
    (run.calls.some((call) => call.tool === "device_screenshot" && usableImage(call)) ||
      shell.some((entry) => successfulScreenshots(entry).length > 0));
  if (expect.noShutdown)
    add(
      "callsMustNot shutdown occupied device",
      !run.calls.some(
        (call, index) =>
          call.tool === "device_close" &&
          record(call.input) &&
          call.input.shutdown === true &&
          openTargets(run.calls.slice(0, index)).some(
            (target) =>
              expect.noShutdown!.some(
                (protectedTarget) =>
                  target.hostId === protectedTarget.hostId &&
                  target.deviceId === protectedTarget.deviceId,
              ) &&
              (!inputString(call.input, "hostId") ||
                inputString(call.input, "hostId") === target.hostId) &&
              (!inputString(call.input, "deviceId") ||
                inputString(call.input, "deviceId") === target.deviceId),
          ),
      ),
    );
  for (const pattern of expect.report ?? [])
    add(
      `device final report /${pattern}/`,
      run.stopReason === "end_turn" &&
        (!!recovered || new RegExp(pattern).test(run.finalText ?? "")),
    );
  if (expect.noRawUi) add("shellMustNot device UI", !allActions.some((action) => action.raw));
  if (expect.maxCaptureAttempts !== undefined)
    add(
      `maxCalls device captures <= ${expect.maxCaptureAttempts}`,
      run.calls.filter((call) => call.tool === "device_screenshot").length +
        allActions.filter((action) => action.managed && action.args[0] === "screenshot").length <=
        expect.maxCaptureAttempts,
    );
  if (expect.capture) {
    const target = expect.capture;
    const matches = (value: ReturnType<typeof inputTarget> | undefined) =>
      value?.hostId === target.hostId && value?.deviceId === target.deviceId;
    const appSessions = new Set<string>();
    let opened = false,
      captured = false;
    for (const [index, call] of run.calls.entries()) {
      if (call.tool === "device_open" && call.failed === false && matches(inputTarget(call)))
        opened = true;
      const appReady = !target.app || (call.failed === false && appSessions.size > 0);
      if (
        opened &&
        appReady &&
        call.tool === "device_screenshot" &&
        matches(screenshotTarget(call, run.calls.slice(0, index))) &&
        (!target.app || usableImage(call))
      )
        captured = true;
      const entry = shell.find(([source]) => source === call);
      const actions = (entry?.[1] ?? []).filter((action) => action.managed && action.bound);
      const screenshots = entry ? successfulScreenshots(entry) : [];
      for (const action of actions) {
        const { args, words } = action;
        const onTarget = matches(launcherTarget(words, run.calls.slice(0, index)));
        // Only an open or close that ran and succeeded changes the app session.
        const ran =
          call.failed === false &&
          action.executed &&
          action.unmasked &&
          !AGENT_DEVICE_ERROR.test(call.output ?? "");
        if (target.app && ["open", "close"].includes(args[0] ?? "") && ran) {
          appSessions.delete(words[0]!);
          if (
            args[0] === "open" &&
            args[1] === target.app &&
            onTarget &&
            (!action.sequenced ||
              (actions.filter((a) => a.args[0] === "open").length === 1 &&
                /^Opened:/m.test(call.output ?? "")))
          )
            appSessions.add(words[0]!);
        }
        if (
          opened &&
          onTarget &&
          (target.app
            ? appSessions.has(words[0]!) && screenshots.includes(action)
            : action.executed &&
              (["screenshot", "snapshot"].includes(args[0] ?? "") ||
                (args[0] === "record" && args[1] === "start")))
        )
          captured = true;
      }
    }
    add("device successful open and capture attempt", captured);
  }
  if (expect.recording !== undefined) {
    const steps = [...shell].flatMap(([call, actions]) => {
      const operations = actions.filter(
        ({ args }) => args[0] === "record" && /^(?:start|stop)$/.test(args[1] ?? ""),
      );
      return operations
        .filter(
          (action) =>
            action.executed &&
            action.unmasked &&
            action.bound &&
            ((!action.sequenced &&
              call.failed === false &&
              !AGENT_DEVICE_ERROR.test(call.output ?? "")) ||
              (operations.filter((o) => o.args[1] === action.args[1]).length === 1 &&
                new RegExp(
                  `(?:^|\\n)[^\\w\\n]*Recording ${action.args[1] === "start" ? "started" : "stopped"}\\b|"kind"\\s*:\\s*"recording${action.args[1] === "start" ? "Started" : "Stopped"}"`,
                  "i",
                ).test(call.output ?? ""))),
        )
        .map(({ args }) => args[1]!);
    });
    const start = steps.indexOf("start");
    checks.push({
      check: `device recording ${expect.recording}`,
      pass:
        start >= 0 &&
        steps.indexOf("stop", start + 1) >= 0 &&
        run.stopReason === "end_turn" &&
        (run.finalText ?? "").includes(expect.recording),
    });
  }
  if (expect.maxFailedAttemptsPerTurn !== undefined) {
    const failedByTurn = new Map<number, number>();
    for (const call of run.calls) {
      const actions = shell.find(([source]) => source === call)?.[1] ?? [];
      // A failed raw attempt, such as agent-device over ssh, is still a failed device attempt.
      const device = actions.filter((action) => action.managed || action.raw).length;
      // agent-device prints one error per failed command, even when a later command succeeds.
      const errors = (call.output ?? "").match(new RegExp(AGENT_DEVICE_ERROR, "g"))?.length ?? 0;
      let discoveryFailed = false;
      if (call.tool === "device_list") {
        try {
          const statuses: unknown = JSON.parse(call.output ?? "").hostStatuses;
          discoveryFailed =
            record(statuses) &&
            Object.values(statuses).some((s) => record(s) && s.status === "failed");
        } catch {}
      }
      const attempts =
        call.tool === "device_list"
          ? Number(!!call.failed || discoveryFailed)
          : /^device_(?:open|screenshot|close)$/.test(call.tool)
            ? Number(!!call.failed)
            : call.failed && device
              ? Math.max(1, Math.min(errors, device))
              : Math.min(errors, device);
      const turn = call.turn ?? 0;
      failedByTurn.set(turn, (failedByTurn.get(turn) ?? 0) + attempts);
    }
    const max = expect.maxFailedAttemptsPerTurn;
    add(
      `maxCalls device failures per user turn <= ${max}`,
      [...failedByTurn.values()].every((count) => count <= max),
    );
  }
  return checks;
}
