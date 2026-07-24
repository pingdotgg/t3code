import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

const TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

const TREE_PATHS = [...TEMPLATE_PATHS, ...TEMPLATE_DIRECTORIES] as const;

type ExecuteGit = GitVcsDriver.GitVcsDriver["Service"]["execute"];

interface TemplateTreeEntry {
  readonly objectId: string;
  readonly path: string;
}

function parseTemplateTreeEntries(output: string): ReadonlyArray<TemplateTreeEntry> {
  const entries: TemplateTreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }

    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }

    const [mode, type, objectId] = record.slice(0, separator).split(" ");
    if (
      type !== "blob" ||
      (mode !== "100644" && mode !== "100755") ||
      !objectId ||
      !/^[0-9a-f]{40,64}$/.test(objectId)
    ) {
      continue;
    }

    entries.push({ objectId, path: record.slice(separator + 1) });
  }
  return entries;
}

function readTemplateBlob(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entry: TemplateTreeEntry;
}): Effect.Effect<Option.Option<string>, GitCommandError> {
  return input
    .executeGit({
      operation: "PrTemplateDetection.readTemplateBlob",
      cwd: input.cwd,
      args: ["cat-file", "blob", input.entry.objectId],
      maxOutputBytes: TEMPLATE_MAX_BYTES,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map((result) => {
        const template = result.stdout.trim();
        if (template.length === 0) {
          return Option.none();
        }
        return Option.some(
          result.stdoutTruncated && !template.endsWith(TRUNCATION_MARKER)
            ? `${template}\n\n${TRUNCATION_MARKER}`
            : template,
        );
      }),
    );
}

type DirectoryTemplateResult =
  | { readonly _tag: "None" }
  | { readonly _tag: "Ambiguous" }
  | { readonly _tag: "Template"; readonly template: string };

function readTemplateDirectory(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entries: ReadonlyArray<TemplateTreeEntry>;
  readonly directory: string;
}): Effect.Effect<DirectoryTemplateResult, GitCommandError> {
  return Effect.gen(function* () {
    const prefix = `${input.directory}/`;
    const candidates = input.entries.filter((entry) => {
      if (!entry.path.startsWith(prefix)) {
        return false;
      }
      const relativePath = entry.path.slice(prefix.length);
      return !relativePath.includes("/") && relativePath.toLowerCase().endsWith(".md");
    });

    const templates: string[] = [];
    for (const entry of candidates) {
      const template = yield* readTemplateBlob({ ...input, entry });
      if (Option.isSome(template)) {
        templates.push(template.value);
        if (templates.length > 1) {
          return { _tag: "Ambiguous" } as const;
        }
      }
    }

    return templates[0]
      ? ({ _tag: "Template", template: templates[0] } as const)
      : ({ _tag: "None" } as const);
  });
}

export const detectPrTemplate = Effect.fn("detectPrTemplate")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    // Worktree paths can be replaced between validation and open. Read regular blobs from the
    // committed base tree so repository-controlled symlinks and path races never reach the host filesystem.
    const result = yield* executeGit({
      operation: "PrTemplateDetection.listTemplates",
      cwd,
      args: ["ls-tree", "-r", "-z", "--full-tree", treeish, "--", ...TREE_PATHS],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (result.stdoutTruncated) {
      return Option.none();
    }

    const entries = parseTemplateTreeEntries(result.stdout);
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const templatePath of TEMPLATE_PATHS) {
      const entry = entriesByPath.get(templatePath);
      if (!entry) {
        continue;
      }
      const template = yield* readTemplateBlob({ cwd, executeGit, entry });
      if (Option.isSome(template)) {
        return template;
      }
    }

    for (const directory of TEMPLATE_DIRECTORIES) {
      const directoryTemplate = yield* readTemplateDirectory({
        cwd,
        executeGit,
        entries,
        directory,
      });
      if (directoryTemplate._tag === "Template") {
        return Option.some(directoryTemplate.template);
      }
      if (directoryTemplate._tag === "Ambiguous") {
        return Option.none();
      }
    }

    return Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none()));
});
