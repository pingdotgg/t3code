import { normalizeHeadroomProxyUrl, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree } from "jsonc-parser";

import type { HeadroomUpstream } from "./OptimizerProbeService.ts";
import {
  inspectCodexHeadroomRouting,
  isCpaUrl,
  resolveDefaultCliConfigFiles,
} from "./HeadroomRouting.ts";

/**
 * Text edits that point the Claude and Codex CLI configs at a local CLIProxyAPI, or take them
 * off it. Every byte outside the touched keys is preserved, so turning routing on then off (or
 * off then on) returns the original file.
 */
export interface CpaRoutingTarget {
  readonly url: string;
  /** Written into Claude's `apiKeyHelper` shell command as-is, so `~` still expands. */
  readonly clientKeyPath: string;
  /** The same key file with `~` expanded, for Codex's argv-style auth command. */
  readonly clientKeyFile: string;
}

const decodeClaudeCpaSettings = Schema.decodeUnknownOption(
  Schema.Struct({
    apiKeyHelper: Schema.optionalKey(Schema.String),
    env: Schema.optionalKey(
      Schema.Struct({ ANTHROPIC_BASE_URL: Schema.optionalKey(Schema.String) }),
    ),
  }),
);

export function claudeSettingsRouteThroughCpa(contents: string, cpaUrl: string): boolean {
  const decoded = decodeClaudeCpaSettings(parse(contents));
  return (
    Option.isSome(decoded) &&
    (decoded.value.apiKeyHelper?.trim() ?? "") !== "" &&
    isCpaUrl(decoded.value.env?.ANTHROPIC_BASE_URL, "claudeAgent", cpaUrl)
  );
}

export function codexConfigRoutesThroughCpa(contents: string): boolean {
  return inspectCodexHeadroomRouting(contents).modelProvider === "cpa";
}

const eolOf = (contents: string) => (contents.includes("\r\n") ? "\r\n" : "\n");

export function setClaudeSettingsCpaRouting(
  contents: string,
  enabled: boolean,
  target: CpaRoutingTarget,
): string {
  const eol = eolOf(contents);
  const indent = /^([ \t]+)"/m.exec(contents)?.[1] ?? "  ";
  const formattingOptions = indent.startsWith("\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
  const base = contents.trim() === "" ? `{}${eol}` : contents;
  const edit = (text: string, path: ReadonlyArray<string>, value: string) =>
    applyEdits(text, modify(text, [...path], value, { formattingOptions }));
  // jsonc-parser throws when deleting under a missing parent.
  const remove = (text: string, path: ReadonlyArray<string>) => {
    const tree = parseTree(text);
    return tree !== undefined && findNodeAtLocation(tree, [...path]) !== undefined
      ? applyEdits(text, modify(text, [...path], undefined, { formattingOptions }))
      : text;
  };
  if (enabled) {
    const withHelper = edit(base, ["apiKeyHelper"], `cat ${target.clientKeyPath}`);
    return edit(withHelper, ["env", "ANTHROPIC_BASE_URL"], target.url);
  }
  const withoutKeys = remove(remove(contents, ["apiKeyHelper"]), ["env", "ANTHROPIC_BASE_URL"]);
  const tree = parseTree(withoutKeys);
  const env = tree === undefined ? undefined : findNodeAtLocation(tree, ["env"]);
  return env?.type === "object" && (env.children?.length ?? 0) === 0
    ? remove(withoutKeys, ["env"])
    : withoutKeys;
}

const TABLE_HEADER = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?\r?$/;
const TOP_LEVEL_MODEL_PROVIDER = /^\s*model_provider\s*=\s*(["'])([^"']*)\1\s*(?:#.*)?\r?$/;

export function setCodexConfigCpaRouting(
  contents: string,
  enabled: boolean,
  target: CpaRoutingTarget,
): string {
  const eol = eolOf(contents);
  const lines = contents.split("\n");
  const firstTable = lines.findIndex((line) => TABLE_HEADER.test(line));
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable;
  const providerLine = lines
    .slice(0, topLevelEnd)
    .findIndex((line) => TOP_LEVEL_MODEL_PROVIDER.test(line));

  if (!enabled) {
    if (providerLine === -1 || TOP_LEVEL_MODEL_PROVIDER.exec(lines[providerLine]!)?.[2] !== "cpa") {
      return contents;
    }
    return lines.filter((_, index) => index !== providerLine).join("\n");
  }

  const providerAssignment = `model_provider = "cpa"${eol === "\r\n" ? "\r" : ""}`;
  const routed =
    providerLine === -1
      ? `model_provider = "cpa"${eol}${contents}`
      : lines.map((line, index) => (index === providerLine ? providerAssignment : line)).join("\n");
  const hasCpaTable = routed
    .split("\n")
    .some((line) => TABLE_HEADER.exec(line)?.[1]?.trim() === "model_providers.cpa");
  if (hasCpaTable) return routed;
  const table = [
    "[model_providers.cpa]",
    `name = "local CLIProxyAPI"`,
    `base_url = ${JSON.stringify(`${target.url}/v1`)}`,
    `wire_api = "responses"`,
    "",
    "[model_providers.cpa.auth]",
    `command = "cat"`,
    `args = [${JSON.stringify(target.clientKeyFile)}]`,
    "",
  ].join(eol);
  const separator = routed.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${routed}${separator}${table}`;
}

export interface CpaRoutingState {
  readonly claudeSettingsPath: string;
  readonly codexConfigPath: string;
  readonly claudeSettings: string;
  readonly codexConfig: string;
  readonly cpaUrl: string;
  readonly claude: boolean;
  readonly codex: boolean;
}

/** Reads routing from the default Claude and Codex config files; a missing file reads as empty. */
export const readCpaRoutingState = Effect.fn("CpaRouting.readState")(function* (
  settings: Pick<ServerSettings, "providerInstances" | "cpa">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = yield* resolveDefaultCliConfigFiles(settings);
  const read = (filePath: string) =>
    fileSystem
      .readFileString(filePath)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
  const claudeSettings = yield* read(files.claudeSettingsPath);
  const codexConfig = yield* read(files.codexConfigPath);
  const cpaUrl = normalizeHeadroomProxyUrl(settings.cpa.url) ?? settings.cpa.url;
  return {
    ...files,
    claudeSettings,
    codexConfig,
    cpaUrl,
    claude: claudeSettingsRouteThroughCpa(claudeSettings, cpaUrl),
    codex: codexConfigRoutesThroughCpa(codexConfig),
  } satisfies CpaRoutingState;
});

export const cpaHeadroomUpstream = (state: CpaRoutingState): HeadroomUpstream => ({
  ...(state.claude ? { anthropic: state.cpaUrl } : {}),
  ...(state.codex ? { openai: `${state.cpaUrl}/v1` } : {}),
});
