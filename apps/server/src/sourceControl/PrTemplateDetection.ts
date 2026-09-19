import { type SourceControlProviderKind, type GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

const GITHUB_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const GITHUB_TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

// GitLab's default merge request template is "Default.md" (case-insensitive) inside
// .gitlab/merge_request_templates/. Other templates in that directory are chosen
// explicitly by name instead of being applied by default.
// https://docs.gitlab.com/user/project/description_templates/
const GITLAB_TEMPLATE_DIRECTORIES = [".gitlab/merge_request_templates"] as const;

// Azure Repos searches these folders in order (.azuredevops, .vsts, docs, root) for
// pull_request_template.md or pull_request_template.txt and uses the first default
// template it finds. Filenames and folder locations are not case sensitive.
// https://learn.microsoft.com/en-us/azure/devops/repos/git/pull-request-templates
const AZURE_DEVOPS_TEMPLATE_PATHS = [
  ".azuredevops/pull_request_template.md",
  ".azuredevops/pull_request_template.txt",
  ".vsts/pull_request_template.md",
  ".vsts/pull_request_template.txt",
  "docs/pull_request_template.md",
  "docs/pull_request_template.txt",
  "pull_request_template.md",
  "pull_request_template.txt",
] as const;

interface ChangeRequestTemplatePaths {
  readonly paths: ReadonlyArray<string>;
  readonly directories: ReadonlyArray<string>;
  // When set, directory templates must match this basename (case-insensitive).
  readonly directoryBaseName?: string;
}

function templatePathsForProvider(
  providerKind: SourceControlProviderKind,
): ChangeRequestTemplatePaths | null {
  switch (providerKind) {
    case "gitlab":
      return {
        paths: [],
        directories: [...GITLAB_TEMPLATE_DIRECTORIES],
        directoryBaseName: "Default",
      };
    case "azure-devops":
      return { paths: [...AZURE_DEVOPS_TEMPLATE_PATHS], directories: [] };
    case "github":
    case "forgejo":
      return { paths: [...GITHUB_TEMPLATE_PATHS], directories: [...GITHUB_TEMPLATE_DIRECTORIES] };
    default:
      // bitbucket and unknown providers have no repository-file change request template
      // convention, matching the historical GitHub-only behavior.
      return null;
  }
}

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
  readonly expectedBaseName?: string | undefined;
}): Effect.Effect<DirectoryTemplateResult, GitCommandError> {
  return Effect.gen(function* () {
    const prefix = `${input.directory}/`;
    const candidates = input.entries.filter((entry) => {
      if (!entry.path.startsWith(prefix)) {
        return false;
      }
      const relativePath = entry.path.slice(prefix.length);
      if (relativePath.includes("/") || !relativePath.toLowerCase().endsWith(".md")) {
        return false;
      }
      if (input.expectedBaseName) {
        const baseName = relativePath.slice(0, relativePath.lastIndexOf("."));
        if (baseName.toLowerCase() !== input.expectedBaseName.toLowerCase()) {
          return false;
        }
      }
      return true;
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
  providerKind: SourceControlProviderKind,
) {
  return yield* Effect.gen(function* () {
    const templatePaths = templatePathsForProvider(providerKind);
    if (templatePaths === null) {
      return Option.none();
    }
    const treePaths = [...templatePaths.paths, ...templatePaths.directories] as const;
    // Worktree paths can be replaced between validation and open. Read regular blobs from the
    // committed base tree so repository-controlled symlinks and path races never reach the host filesystem.
    const result = yield* executeGit({
      operation: "PrTemplateDetection.listTemplates",
      cwd,
      args: ["ls-tree", "-r", "-z", "--full-tree", treeish, "--", ...treePaths],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (result.stdoutTruncated) {
      return Option.none();
    }

    const entries = parseTemplateTreeEntries(result.stdout);
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const templatePath of templatePaths.paths) {
      const entry = entriesByPath.get(templatePath);
      if (!entry) {
        continue;
      }
      const template = yield* readTemplateBlob({ cwd, executeGit, entry });
      if (Option.isSome(template)) {
        return template;
      }
    }

    for (const directory of templatePaths.directories) {
      const directoryTemplate = yield* readTemplateDirectory({
        cwd,
        executeGit,
        entries,
        directory,
        expectedBaseName: templatePaths.directoryBaseName,
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
