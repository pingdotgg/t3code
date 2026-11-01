import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

const TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.txt",
  ".github/PULL_REQUEST_TEMPLATE.txt",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.txt",
  "PULL_REQUEST_TEMPLATE.txt",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.txt",
  "docs/PULL_REQUEST_TEMPLATE.txt",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

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
      operation: "gitHubChangeRequestTemplate.readTemplateBlob",
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

const readTemplateDirectory = Effect.fn("gitHubChangeRequestTemplate.readTemplateDirectory")(
  function* (input: {
    readonly cwd: string;
    readonly executeGit: ExecuteGit;
    readonly entries: ReadonlyArray<TemplateTreeEntry>;
    readonly directory: string;
  }): Effect.fn.Return<DirectoryTemplateResult, GitCommandError> {
    const prefix = `${input.directory}/`;
    const candidates = input.entries.filter((entry) => {
      if (!entry.path.startsWith(prefix)) {
        return false;
      }
      const relativePath = entry.path.slice(prefix.length);
      return !relativePath.includes("/") && /\.(?:md|txt)$/i.test(relativePath);
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
  },
);

export const detect = Effect.fn("gitHubChangeRequestTemplate.detect")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    // Read committed regular blobs; worktree paths can become symlinks between validation and open.
    // ls-tree does not support case-insensitive pathspecs; grep discovers only matching names.
    const paths = yield* executeGit({
      operation: "gitHubChangeRequestTemplate.findTemplatePaths",
      cwd,
      args: [
        "grep",
        "-G",
        "--no-color",
        "-l",
        "-z",
        "--full-name",
        "--no-recurse-submodules",
        "-e",
        "^",
        treeish,
        "--",
        ...TEMPLATE_PATHS.map((path) => `:(top,icase,literal)${path}`),
      ],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
    }).pipe(
      Effect.map((result) =>
        result.stdoutTruncated
          ? []
          : result.stdout
              .split("\0")
              .filter((path) => path.startsWith(`${treeish}:`))
              .map((path) => path.slice(treeish.length + 1)),
      ),
      // grep exits with status 1 when no nonempty templates match.
      Effect.orElseSucceed(() => []),
    );
    const result = yield* executeGit({
      operation: "gitHubChangeRequestTemplate.listTemplates",
      cwd,
      args: [
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        treeish,
        "--",
        ...new Set([...TEMPLATE_PATHS, ...paths]),
        ...TEMPLATE_DIRECTORIES,
      ],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (result.stdoutTruncated) {
      return Option.none();
    }

    const entries = parseTemplateTreeEntries(result.stdout);
    const candidates = [".github/", "", "docs/"].flatMap((location) => {
      const paths = TEMPLATE_PATHS.filter(
        (path) => path.slice(0, path.lastIndexOf("/") + 1) === location,
      );
      return [
        ...paths.flatMap((path) => entries.filter((entry) => entry.path === path)),
        ...entries.filter(
          (entry) =>
            !paths.some((path) => path === entry.path) &&
            paths.some((path) => path.toLowerCase() === entry.path.toLowerCase()),
        ),
      ];
    });
    for (const entry of candidates) {
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
