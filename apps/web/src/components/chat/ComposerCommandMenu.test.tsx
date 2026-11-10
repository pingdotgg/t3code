import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { retainPendingComposerMenuItems } from "./composerMenuResults";
import { describe, expect, it } from "vite-plus/test";

import {
  groupComposerCommandItems,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "./ComposerCommandMenu";

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/\ufffd.md",
      "docs/\\ud800.md",
      "docs/\ud83d\ude80.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

describe("groupComposerCommandItems", () => {
  it("keeps mention groups in the same order when match ranking changes", () => {
    const path = {
      id: "path:src",
      type: "path",
      label: "src",
      description: "",
      path: "src",
      pathKind: "directory",
      searchTarget: { environmentId: null, cwd: null, query: "src" },
    } satisfies ComposerCommandItem;
    const thread = {
      id: "thread:src",
      type: "thread",
      label: "src",
      description: "",
      thread: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
    } satisfies ComposerCommandItem;
    expect(groupComposerCommandItems([path, thread], "path").map((group) => group.key)).toEqual([
      "threads",
      "paths",
    ]);
    expect(groupComposerCommandItems([thread, path], "path").map((group) => group.key)).toEqual([
      "threads",
      "paths",
    ]);
  });
});

it("retains the settled mention list until search completes, scoped to the open menu", () => {
  const previous = { scope: "env:/repo:thread:0", items: [{ id: "file" }, { id: "thread" }] };
  const partial = [{ id: "thread" }];
  expect(retainPendingComposerMenuItems(previous, previous.scope, partial, true)).toBe(
    previous.items,
  );
  expect(retainPendingComposerMenuItems(previous, previous.scope, partial, false)).toBe(partial);
  expect(retainPendingComposerMenuItems(previous, "other-repo", [], true)).toEqual([]);
});
