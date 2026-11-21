import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { assembleNotes, previousTag } from "./release-notes.mjs";

NodeTest.test("the previous tag skips upstream's tags and later boards", () => {
  const tags = ["board-v0.1.0", "board-v0.2.0", "v0.1.11"];
  NodeAssert.equal(previousTag(tags, "board-v0.2.0"), "board-v0.1.0");
  NodeAssert.equal(previousTag(tags, "board-v0.10.0"), "board-v0.2.0");
  NodeAssert.equal(previousTag(tags, "board-v0.1.0"), undefined);
});

NodeTest.test("the notes are the summary over GitHub's list", () => {
  const summary = "- You can cut a release with one command.";
  const list = "## What's Changed\n* ship releases by @kyle in #1\n";
  NodeAssert.equal(
    assembleNotes(summary, list),
    "- You can cut a release with one command.\n\n## What's Changed\n* ship releases by @kyle in #1\n",
  );
});
