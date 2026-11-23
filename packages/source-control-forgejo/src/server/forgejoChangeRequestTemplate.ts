import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

// Forgejo's Markdown lookup order also preserves Gitea's root, .gitea, .github order.
const TEMPLATE_PATHS = ["", ".forgejo/", ".gitea/", ".github/", "docs/"].flatMap((directory) => [
  `${directory}PULL_REQUEST_TEMPLATE.md`,
  `${directory}pull_request_template.md`,
]);
const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

export const detect = Effect.fn("forgejoChangeRequestTemplate.detect")(
  function* (cwd: string, treeish: string, executeGit: ExecuteGit) {
    const listing = yield* executeGit({
      operation: "forgejoChangeRequestTemplate.listTemplates",
      cwd,
      args: ["ls-tree", "-z", "--full-tree", treeish, "--", ...TEMPLATE_PATHS],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (listing.stdoutTruncated) {
      return Option.none();
    }

    // Read only regular blobs from the target tree, including when the worktree has a symlink.
    const objectsByPath = new Map<string, string>();
    for (const record of listing.stdout.split("\0")) {
      const entry = /^100(?:644|755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record);
      if (entry?.[1] && entry[2]) {
        objectsByPath.set(entry[2], entry[1]);
      }
    }

    for (const path of TEMPLATE_PATHS) {
      const objectId = objectsByPath.get(path);
      if (!objectId) {
        continue;
      }
      const blob = yield* executeGit({
        operation: "forgejoChangeRequestTemplate.readTemplate",
        cwd,
        args: ["cat-file", "blob", objectId],
        maxOutputBytes: TEMPLATE_MAX_BYTES,
        appendTruncationMarker: true,
      });
      const template = blob.stdout.trim();
      if (template.length > 0) {
        return Option.some(
          blob.stdoutTruncated && !template.endsWith(TRUNCATION_MARKER)
            ? `${template}\n\n${TRUNCATION_MARKER}`
            : template,
        );
      }
    }
    return Option.none();
  },
  Effect.orElseSucceed(() => Option.none()),
);
