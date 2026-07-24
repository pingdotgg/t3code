import {
  T3_PROJECT_FILE_SCHEMA_URL,
  type ProjectScript,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Schema from "effect/Schema";

const decodeT3ProjectFile = Schema.decodeUnknownSync(T3ProjectFileFromJson);
const decodeLenientJson = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));
const MAX_PROJECT_FILE_SCRIPTS = 50;

function isSameScript(
  fileScript: T3ProjectFileScript,
  script: Pick<ProjectScript, "name" | "command">,
): boolean {
  return (
    fileScript.command === script.command ||
    fileScript.name.toLowerCase() === script.name.toLowerCase()
  );
}

export function projectFileScriptFromProjectScript(script: ProjectScript): T3ProjectFileScript {
  return {
    name: script.name,
    command: script.command,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    ...(script.previewUrl ? { previewUrl: script.previewUrl } : {}),
    ...(script.previewUrl ? { autoOpenPreview: script.autoOpenPreview ?? false } : {}),
  };
}

/**
 * Adds or updates an action in a checked-in t3.json document.
 *
 * An edited action is matched against its previous values first. Matching the
 * next name or command as a fallback keeps repeated share attempts idempotent.
 */
export function upsertT3ProjectFileScript(input: {
  readonly contents: string | null;
  readonly script: ProjectScript;
  readonly previousScript?: ProjectScript;
}): string {
  let projectFile: T3ProjectFile;
  let rawProjectFile: Record<string, unknown>;
  try {
    if (input.contents === null) {
      projectFile = { $schema: T3_PROJECT_FILE_SCHEMA_URL };
      rawProjectFile = {};
    } else {
      projectFile = decodeT3ProjectFile(input.contents);
      const raw = decodeLenientJson(input.contents);
      rawProjectFile =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
    }
  } catch {
    throw new Error("t3.json is invalid. Fix the file before sharing this action.");
  }

  const nextFileScript = projectFileScriptFromProjectScript(input.script);
  const decodedScripts = projectFile.scripts ?? [];
  const existingIndex = decodedScripts.findIndex(
    (fileScript) =>
      (input.previousScript !== undefined && isSameScript(fileScript, input.previousScript)) ||
      isSameScript(fileScript, input.script),
  );
  if (existingIndex === -1 && decodedScripts.length >= MAX_PROJECT_FILE_SCRIPTS) {
    throw new Error("t3.json already contains the maximum of 50 shared actions.");
  }

  const scripts = Array.isArray(rawProjectFile.scripts)
    ? [...rawProjectFile.scripts]
    : [...decodedScripts];
  if (existingIndex === -1) {
    scripts.push(nextFileScript);
  } else {
    scripts[existingIndex] = nextFileScript;
  }

  return `${JSON.stringify(
    {
      ...rawProjectFile,
      $schema: projectFile.$schema ?? T3_PROJECT_FILE_SCHEMA_URL,
      scripts,
    },
    null,
    2,
  )}\n`;
}
