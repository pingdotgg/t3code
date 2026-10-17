/**
 * GitLab's default merge request template: `Default.md` (any letter case) in
 * `.gitlab/merge_request_templates`, read from the committed base tree. The other files in that
 * directory are templates a user picks by hand, so none of them is ever the default.
 *
 * @module source-control-gitlab/server/gitLabChangeRequestTemplate
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const TEMPLATE_DIRECTORY = ".gitlab/merge_request_templates";
const DEFAULT_TEMPLATE_FILE = "default.md";
const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

export const detect = Effect.fn("gitLabChangeRequestTemplate.detect")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    // Read a regular blob from the committed tree, so a repository-controlled symlink or a
    // worktree path replaced mid-read never reaches the host filesystem.
    const listing = yield* executeGit({
      operation: "gitLabChangeRequestTemplate.listTemplates",
      cwd,
      args: ["ls-tree", "-z", "--full-tree", treeish, "--", `${TEMPLATE_DIRECTORY}/`],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (listing.stdoutTruncated) {
      return Option.none<string>();
    }

    // Each record is `<mode> <type> <object>\t<path>`; 100644 and 100755 are regular files.
    const objectId = listing.stdout
      .split("\0")
      .map((record) => /^100(?:644|755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record))
      .find(
        (match) => match?.[2]?.toLowerCase() === `${TEMPLATE_DIRECTORY}/${DEFAULT_TEMPLATE_FILE}`,
      )?.[1];
    if (!objectId) {
      return Option.none<string>();
    }

    const blob = yield* executeGit({
      operation: "gitLabChangeRequestTemplate.readTemplate",
      cwd,
      args: ["cat-file", "blob", objectId],
      maxOutputBytes: TEMPLATE_MAX_BYTES,
      appendTruncationMarker: true,
    });
    const template = blob.stdout.trim();
    if (template.length === 0) {
      return Option.none<string>();
    }
    return Option.some(
      blob.stdoutTruncated && !template.endsWith(TRUNCATION_MARKER)
        ? `${template}\n\n${TRUNCATION_MARKER}`
        : template,
    );
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
});
