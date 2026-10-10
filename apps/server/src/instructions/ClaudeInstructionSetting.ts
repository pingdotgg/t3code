/**
 * ClaudeInstructionSetting - Claude's "Project instructions" setting, the import line that lets a
 * CLAUDE.md read an AGENTS.md, and the Claude Code version that can read AGENTS.md at all.
 *
 * Pure functions over parsed JSON and text; the caller reads and writes the files. Sources:
 * https://code.claude.com/docs/en/memory ("Choose which instruction files load", "Import
 * additional files", "When AGENTS.md support is unavailable").
 *
 * The setting is `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles` in the
 * Claude config folder's `settings.json`. Claude Code ignores it in project and local settings.
 * Before 2.1.285 the plugin's id was `agents-md@builtin` and Claude Code 2.1.285 and later reads
 * either, so reading checks both ids and writing keeps a legacy entry that has a value in step.
 *
 * Imports are `@path` in the text of a CLAUDE.md. Only an import that is a line by itself is
 * managed here; Claude also imports a path mentioned inside a sentence, which these functions
 * neither detect nor remove. Lines inside fenced code blocks are not imports, as in Claude.
 *
 * @module ClaudeInstructionSetting
 */
import { ClaudeInstructionValue } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseJsonc, type JsoncChange } from "../skills/JsoncSettings.ts";

/** What Claude does when the setting is absent: AGENTS.md only when there is no CLAUDE.md. */
export const DEFAULT_CLAUDE_INSTRUCTION_VALUE: ClaudeInstructionValue = "claude-md-or-agents-md";

/** The first Claude Code release that reads AGENTS.md. */
const MIN_AGENTS_MD_CLAUDE_VERSION = "2.1.277";

const PLUGIN_ID = "cc-plugin-agents-md@builtin";
const LEGACY_PLUGIN_ID = "agents-md@builtin";
const OPTION = "instructionFiles";

const settingPath = (pluginId: string) => ["pluginConfigs", pluginId, "options", OPTION] as const;

/** A parsed JSON object, such as the contents of `settings.json`. */
export type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInstructionValue = Schema.is(ClaudeInstructionValue);

const getIn = (root: unknown, keys: readonly string[]): unknown => {
  let current = root;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
};

/**
 * The text of a `settings.json` as an object, or `undefined` when Claude couldn't read it as one.
 * Comments and trailing commas are fine, as they are for the skill settings in the same file. A
 * byte order mark in front of the text, which the file reads keep, isn't part of the JSON.
 */
export const parseSettingsJson = (text: string): JsonObject | undefined => {
  const { value, valid } = parseJsonc(text.startsWith("\uFEFF") ? text.slice(1) : text);
  return valid && isObject(value) ? value : undefined;
};

export interface ClaudeInstructionSetting {
  readonly value: ClaudeInstructionValue;
  /** False when no known value is set and `value` is Claude's default. */
  readonly explicit: boolean;
}

/** The "Project instructions" value in a parsed `settings.json`. */
export const readClaudeInstructionSetting = (settings: unknown): ClaudeInstructionSetting => {
  for (const pluginId of [PLUGIN_ID, LEGACY_PLUGIN_ID]) {
    const value = getIn(settings, settingPath(pluginId));
    if (isInstructionValue(value)) return { value, explicit: true };
  }
  return { value: DEFAULT_CLAUDE_INSTRUCTION_VALUE, explicit: false };
};

/**
 * What to change in a `settings.json` (for `editJsoncFile`) to set "Project instructions" to
 * `value`, or back to Claude's default when `value` is null: the entry goes, and the editor takes
 * the objects it leaves empty with it. A legacy entry that has a value is kept in step. Everything
 * else is left as it is, so the editor refuses (and the caller leaves the file alone) when
 * `pluginConfigs` or the plugin's entry exists but isn't an object.
 */
export const claudeInstructionChanges = (
  settings: JsonObject,
  value: ClaudeInstructionValue | null,
): ReadonlyArray<JsoncChange> => {
  if (value === null) {
    return [PLUGIN_ID, LEGACY_PLUGIN_ID].flatMap((pluginId) =>
      getIn(settings, settingPath(pluginId)) === undefined
        ? []
        : [{ path: settingPath(pluginId), value: undefined }],
    );
  }
  return [
    { path: settingPath(PLUGIN_ID), value },
    ...(getIn(settings, settingPath(LEGACY_PLUGIN_ID)) === undefined
      ? []
      : [{ path: settingPath(LEGACY_PLUGIN_ID), value }]),
  ];
};

/**
 * Whether a Claude Code version can read AGENTS.md. Takes the first word, so
 * `2.1.291 (Claude Code)` works. Prereleases sort below their release, and anything that isn't a
 * version is false.
 */
export const supportsAgentsMd = (version: string | null | undefined): boolean => {
  const word = version?.trim().split(/\s+/)[0]?.split("+")[0];
  if (word === undefined || word === "" || parseSemver(word) === null) return false;
  return compareSemverVersions(word, MIN_AGENTS_MD_CLAUDE_VERSION) >= 0;
};

export interface AgentsMdImportTarget {
  /** Resolves the paths, so the answer follows the platform the files are on. */
  readonly path: Path.Path;
  /** The AGENTS.md the import points at. */
  readonly agentsMdPath: string;
  /** The folder of the CLAUDE.md; a relative import resolves against it. */
  readonly claudeMdDirectory: string;
  /** What `~` means in an import. */
  readonly homeDirectory: string;
}

/** The import line for the target: `@~/...` under the home directory, else the absolute path. */
export const agentsMdImportLine = (target: AgentsMdImportTarget): string => {
  const { path } = target;
  const relative = path.relative(target.homeDirectory, target.agentsMdPath);
  const inHome =
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  const written = inHome ? `~/${relative.split(path.sep).join("/")}` : target.agentsMdPath;
  return `@${written.replaceAll(" ", "\\ ")}`;
};

/** The path an import line points at, or `undefined` when the line is not an import by itself. */
const importedPath = (line: string, target: AgentsMdImportTarget): string | undefined => {
  const body = line.trim();
  if (!body.startsWith("@")) return undefined;
  const written = body.slice(1);
  if (written === "" || /(?<!\\)\s/.test(written)) return undefined;
  const imported = written.replaceAll("\\ ", " ");
  if (imported === "~" || imported.startsWith("~/")) {
    return target.path.resolve(target.homeDirectory, imported.slice(2));
  }
  return target.path.resolve(target.claudeMdDirectory, imported);
};

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Each line of the text with its line ending, and whether it is an import of the target. */
const scanImports = (text: string, target: AgentsMdImportTarget) => {
  const resolvedTarget = target.path.resolve(target.agentsMdPath);
  let fence: { readonly marker: string; readonly length: number } | undefined;
  return text
    .split(/(?<=\n)/)
    .filter((line) => line !== "")
    .map((line) => {
      const content = line.replace(/\r?\n$/, "");
      const opened = FENCE.exec(content);
      if (fence === undefined) {
        if (opened?.[1] !== undefined) {
          fence = { marker: opened[1].charAt(0), length: opened[1].length };
          return { line, isImport: false };
        }
        return { line, isImport: importedPath(content, target) === resolvedTarget };
      }
      const closes =
        opened?.[1] !== undefined &&
        opened[1].charAt(0) === fence.marker &&
        opened[1].length >= fence.length &&
        opened[2]?.trim() === "";
      if (closes) fence = undefined;
      return { line, isImport: false };
    });
};

/** Whether the text has a line that imports the target. */
export const hasAgentsMdImport = (text: string, target: AgentsMdImportTarget): boolean =>
  scanImports(text, target).some((entry) => entry.isImport);

/**
 * The text with an import of the target as its first line and everything else as it was. Text
 * that already imports the target comes back as it is.
 */
export const addAgentsMdImport = (text: string, target: AgentsMdImportTarget): string => {
  if (hasAgentsMdImport(text, target)) return text;
  const lineEnding = /\r?\n/.exec(text)?.[0] ?? "\n";
  const bom = text.startsWith("﻿") ? "﻿" : "";
  return `${bom}${agentsMdImportLine(target)}${lineEnding}${text.slice(bom.length)}`;
};

/** The text without any line that imports the target, everything else as it was. */
export const removeAgentsMdImport = (text: string, target: AgentsMdImportTarget): string => {
  const kept = scanImports(text, target)
    .filter((entry) => !entry.isImport)
    .map((entry) => entry.line)
    .join("");
  return kept !== "" && text.startsWith("\uFEFF") && !kept.startsWith("\uFEFF")
    ? `\uFEFF${kept}`
    : kept;
};
