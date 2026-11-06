import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const TEMPLATE_DIRECTORIES = [".azuredevops", ".vsts", "docs", ""];
const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

export const detect = Effect.fn("azureDevOpsChangeRequestTemplate.detect")(
  function* (cwd: string, treeish: string, executeGit: ExecuteGit) {
    // Inspect only the root and template directories; never recurse through the repository.
    const root = yield* executeGit({
      operation: "azureDevOpsChangeRequestTemplate.listTemplates",
      cwd,
      args: ["ls-tree", "-z", "--full-tree", treeish],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (root.stdoutTruncated) {
      return Option.none();
    }

    const rootEntries = root.stdout.split("\0");
    let objectId: string | undefined;
    for (const directory of TEMPLATE_DIRECTORIES) {
      let entries = rootEntries;
      if (directory !== "") {
        const trees = rootEntries.flatMap((record) => {
          const entry = /^040000 tree ([0-9a-f]{40,64})\t(.+)$/.exec(record);
          return entry?.[1] && entry[2]?.toLowerCase() === directory ? [entry[1]] : [];
        });
        entries = [];
        for (const tree of trees) {
          const listing = yield* executeGit({
            operation: "azureDevOpsChangeRequestTemplate.listTemplates",
            cwd,
            args: ["ls-tree", "-z", "--full-tree", tree],
            maxOutputBytes: TREE_LIST_MAX_BYTES,
            appendTruncationMarker: true,
          });
          if (listing.stdoutTruncated) {
            return Option.none();
          }
          entries.push(...listing.stdout.split("\0"));
        }
      }
      // Only regular committed blobs qualify, so symlinks never reach the host filesystem.
      objectId = entries
        .map((record) => /^100(?:644|755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record))
        .find((entry) => /^pull_request_template\.(?:md|txt)$/i.test(entry?.[2] ?? ""))?.[1];
      if (objectId) {
        break;
      }
    }
    if (!objectId) {
      return Option.none();
    }

    const blob = yield* executeGit({
      operation: "azureDevOpsChangeRequestTemplate.readTemplate",
      cwd,
      args: ["cat-file", "blob", objectId],
      maxOutputBytes: TEMPLATE_MAX_BYTES,
      appendTruncationMarker: true,
    });
    const template = blob.stdout.trim();
    if (template.length === 0) {
      return Option.none();
    }
    return Option.some(
      blob.stdoutTruncated && !template.endsWith(TRUNCATION_MARKER)
        ? `${template}\n\n${TRUNCATION_MARKER}`
        : template,
    );
  },
  Effect.orElseSucceed(() => Option.none()),
);
