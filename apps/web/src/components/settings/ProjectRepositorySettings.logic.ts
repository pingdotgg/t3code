import { ProjectReadFileError, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Schema from "effect/Schema";
import { applyEdits, modify } from "jsonc-parser";

export type RepositorySettings = NonNullable<T3ProjectFile["repositories"]>;
const isReadError = Schema.is(ProjectReadFileError);

export function isMissingProjectConfig(error: unknown): boolean {
  return (
    isReadError(error) &&
    error.code === "ENOENT" &&
    (error.operation === "realpath-target" || error.operation === "open")
  );
}

export function parseRepositoryPaths(text: string): string[] {
  const paths = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (paths.length > 100) throw new Error("Use at most 100 repository paths.");
  for (const path of paths) {
    const directory = path.endsWith("/*") ? path.slice(0, -2) : path;
    if (
      !directory ||
      !directory.split("/").some((segment) => segment !== "" && segment !== ".") ||
      path.length > 512 ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.split("/").includes("..") ||
      /[*?[]/.test(directory)
    ) {
      throw new Error(
        `Invalid repository path: ${path}. Use a relative path or a trailing /*, such as projects/*.`,
      );
    }
  }
  return paths;
}

export function updateRepositoryConfig(contents: string, settings: RepositorySettings): string {
  if (parseT3ProjectFile(contents) === null) {
    throw new Error("Fix the invalid t3.json before saving repository settings.");
  }
  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: contents.includes("\r\n") ? "\r\n" : "\n",
  };
  let next = contents;
  for (const [key, value] of Object.entries(settings)) {
    next = applyEdits(next, modify(next, ["repositories", key], value, { formattingOptions }));
  }
  return next;
}
