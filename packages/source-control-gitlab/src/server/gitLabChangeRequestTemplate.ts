import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const TEMPLATE_DIRECTORY = ".gitlab/merge_request_templates";
const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

export const detect = Effect.fn("gitLabChangeRequestTemplate.detect")(
  function* (cwd: string, treeish: string, executeGit: ExecuteGit) {
    // Read committed regular blobs so symlinks never reach the host filesystem.
    const listing = yield* executeGit({
      operation: "gitLabChangeRequestTemplate.listTemplates",
      cwd,
      args: ["ls-tree", "-z", "--full-tree", treeish, "--", `${TEMPLATE_DIRECTORY}/`],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (listing.stdoutTruncated) {
      return Option.none();
    }

    const objectId = listing.stdout
      .split("\0")
      .map((record) => /^100(?:644|755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record))
      .find((entry) => entry?.[2]?.toLowerCase() === `${TEMPLATE_DIRECTORY}/default.md`)?.[1];
    if (!objectId) {
      return Option.none();
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
