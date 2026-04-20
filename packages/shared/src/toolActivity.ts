import type { ToolLifecycleItemType } from "@t3tools/contracts";

export type LocalhostUrlSource = "detail" | "output" | "raw-output" | "structured-data";

export interface LocalhostUrlCandidate {
  readonly url: string;
  readonly href: string;
  readonly host: string;
  readonly port: number | null;
  readonly source: LocalhostUrlSource;
}

export interface NormalizedCommandActivity {
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly outputPreview: string | null;
  readonly urls: ReadonlyArray<LocalhostUrlCandidate>;
  readonly hasLocalUrl: boolean;
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

const LOCALHOST_URL_PATTERN =
  /https?:\/\/(?<host>localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(?<port>\d{1,5})(?<suffix>[^\s<>"']*)?/giu;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripTrailingUrlPunctuation(value: string): string {
  let next = value;
  while (/[.,)\]}]$/u.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

function hrefForLocalhostUrl(url: string, host: string): string {
  if (host === "localhost") {
    return url;
  }
  // Treat all loopback hosts as equivalent for dedup so an agent that prints
  // both "http://localhost:5173" and "http://127.0.0.1:5173" yields a single
  // chip. The visible `url` field preserves the original spelling.
  return url.replace(`://${host}:`, "://localhost:");
}

export function extractLocalhostUrlsFromText(
  text: string,
  source: LocalhostUrlCandidate["source"],
): ReadonlyArray<LocalhostUrlCandidate> {
  const urls: LocalhostUrlCandidate[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(LOCALHOST_URL_PATTERN)) {
    const host = match.groups?.host;
    const portText = match.groups?.port;
    if (!host || !portText) {
      continue;
    }
    const port = Number.parseInt(portText, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      continue;
    }

    const url = stripTrailingUrlPunctuation(match[0]);
    const href = hrefForLocalhostUrl(url, host);
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    urls.push({
      url,
      href,
      host,
      port,
      source,
    });
  }

  return urls;
}

function normalizeCommandArrayPart(value: string): string {
  return /[\s"'`]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.map(normalizeCommandArrayPart).join(" ") : undefined;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/u);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/iu,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/iu,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/iu,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function commandCandidate(value: unknown): { command: string; rawCommand: string | null } | null {
  const formatted = formatCommandValue(value);
  if (!formatted) {
    return null;
  }
  const command = unwrapKnownShellCommandWrapper(formatted);
  return {
    command,
    rawCommand: formatted === command ? null : formatted,
  };
}

function safeCommandCandidate(value: unknown): {
  command: string;
  rawCommand: string | null;
} | null {
  const candidate = commandCandidate(value);
  if (!candidate) {
    return null;
  }
  return candidate.rawCommand !== null || isSafeCommandFallback(candidate.command)
    ? candidate
    : null;
}

function executableCommandCandidate(rawInput: Record<string, unknown> | undefined): {
  command: string;
  rawCommand: string | null;
} | null {
  const executable = asTrimmedString(rawInput?.executable);
  if (!executable) {
    return null;
  }
  const args = Array.isArray(rawInput?.args)
    ? rawInput.args.map((arg) => asTrimmedString(arg)).filter((arg): arg is string => !!arg)
    : [];
  const formatted = [
    normalizeCommandArrayPart(executable),
    ...args.map(normalizeCommandArrayPart),
  ].join(" ");
  const command = unwrapKnownShellCommandWrapper(formatted);
  return {
    command,
    rawCommand: formatted === command ? null : formatted,
  };
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function looksLikeServerBanner(value: string): boolean {
  return (
    /^https?:\/\//iu.test(value) ||
    /(?:local|network):\s+https?:\/\//iu.test(value) ||
    /ready in \d+/iu.test(value) ||
    /(?:listening|server)\s+(?:on|at)/iu.test(value)
  );
}

function isSafeCommandFallback(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 360 || /[\r\n]/u.test(trimmed)) {
    return false;
  }
  if (
    looksLikeServerBanner(trimmed) ||
    extractLocalhostUrlsFromText(trimmed, "detail").length > 0
  ) {
    return false;
  }
  return /(?:^|\s)(?:bun|npm|pnpm|yarn|npx|node|deno|python|python3|ruby|go|cargo|make|cmake|docker|git|bash|sh|zsh|uv|tsx|ts-node|turbo|vite|next|astro|remix|\.\/)[\s\w./:=@-]*/iu.test(
    trimmed,
  );
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const conventional =
    /^(?:bash|shell|terminal|command|ran command|running)\s*:\s*(?<command>[\s\S]+)$/iu.exec(title)
      ?.groups?.command;
  const conventionalCommand = asTrimmedString(conventional);
  if (conventionalCommand && isSafeCommandFallback(conventionalCommand)) {
    return conventionalCommand;
  }
  const backtickCommand = asTrimmedString(/`([^`]+)`/u.exec(title)?.[1]);
  return backtickCommand && isSafeCommandFallback(backtickCommand) ? backtickCommand : undefined;
}

function outputPreview(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return null;
  }
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

function collectOutputTexts(data: Record<string, unknown> | undefined): Array<{
  text: string;
  source: LocalhostUrlCandidate["source"];
}> {
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const state = asRecord(data?.state);
  const result = asRecord(data?.result);
  const texts: Array<{ text: string; source: LocalhostUrlCandidate["source"] }> = [];

  for (const value of [
    rawOutput?.content,
    rawOutput?.stdout,
    rawOutput?.stderr,
    rawOutput?.output,
  ]) {
    const text = asTrimmedString(value);
    if (text) {
      texts.push({ text, source: "raw-output" });
    }
  }

  for (const value of [
    data?.output,
    data?.stdout,
    data?.stderr,
    item?.output,
    itemResult?.output,
    itemResult?.stdout,
    itemResult?.stderr,
    result?.output,
    state?.output,
    state?.stdout,
    state?.stderr,
  ]) {
    const text = asTrimmedString(value);
    if (text) {
      texts.push({ text, source: "structured-data" });
    }
  }

  return texts;
}

export function normalizeCommandActivityPayload(input: {
  readonly itemType?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly outputText?: string | null | undefined;
}): NormalizedCommandActivity {
  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const inputData = asRecord(data?.input);
  const state = asRecord(data?.state);
  const stateInput = asRecord(state?.input);
  const candidates = [
    commandCandidate(item?.command),
    commandCandidate(itemInput?.command),
    commandCandidate(itemResult?.command),
    commandCandidate(data?.command),
    commandCandidate(rawInput?.command),
    executableCommandCandidate(rawInput),
    commandCandidate(inputData?.command),
    commandCandidate(inputData?.cmd),
    commandCandidate(state?.command),
    commandCandidate(state?.cmd),
    commandCandidate(stateInput?.command),
  ].filter((entry): entry is { command: string; rawCommand: string | null } => entry !== null);

  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const titleCommand = extractCommandFromTitle(asTrimmedString(input.title));
  const detailTitleCommand = extractCommandFromTitle(detail);
  const detailCommand =
    candidates.length === 0 && detail
      ? detailTitleCommand
        ? { command: detailTitleCommand, rawCommand: null }
        : safeCommandCandidate(detail)
      : null;
  const selectedCommand =
    candidates[0] ??
    (titleCommand ? { command: titleCommand, rawCommand: null } : null) ??
    detailCommand;

  const urls: LocalhostUrlCandidate[] = [];
  const seenUrls = new Set<string>();
  const appendUrls = (nextUrls: ReadonlyArray<LocalhostUrlCandidate>) => {
    for (const url of nextUrls) {
      if (seenUrls.has(url.href)) {
        continue;
      }
      seenUrls.add(url.href);
      urls.push(url);
    }
  };

  if (detail) {
    appendUrls(extractLocalhostUrlsFromText(detail, "detail"));
  }

  const outputText = asTrimmedString(input.outputText);
  if (outputText) {
    appendUrls(extractLocalhostUrlsFromText(outputText, "output"));
  }

  const dataOutputTexts = collectOutputTexts(data);
  for (const output of dataOutputTexts) {
    appendUrls(extractLocalhostUrlsFromText(output.text, output.source));
  }

  return {
    command: selectedCommand?.command ?? null,
    rawCommand: selectedCommand?.rawCommand ?? null,
    outputPreview:
      outputPreview(outputText) ??
      dataOutputTexts.map((output) => outputPreview(output.text)).find((text) => text) ??
      null,
    urls,
    hasLocalUrl: urls.length > 0,
  };
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    const commandActivity = normalizeCommandActivityPayload({
      itemType: input.itemType,
      title,
      detail,
      data: input.data,
    });
    return {
      summary: "Ran command",
      ...(commandActivity.command ? { detail: commandActivity.command } : {}),
    };
  }

  if (action === "read") {
    const primaryPath = extractPrimaryPath(data);
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    const primaryPath = extractPrimaryPath(data);
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm);
    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
