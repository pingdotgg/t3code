import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { commentCounts, messageIssues } from "./policy.mjs";

NodeTest.test("rejects em dashes and attribution, not references to supported providers", () => {
  NodeAssert.equal(messageIssues("fix: repair Codex and Claude Code setup").length, 0);
  NodeAssert.equal(messageIssues("fix: splash \u2014 layout").length, 1);
  NodeAssert.equal(
    messageIssues("fix: splash\n\nCo-authored-by: Codex <codex@example.test>").length,
    1,
  );
  NodeAssert.equal(messageIssues("fix: splash\n\nGenerated with Pi").length, 1);
});

NodeTest.test(
  "counts whole comments, block lines and inline comments, but not URLs or shebangs",
  () => {
    NodeAssert.deepEqual(
      commentCounts(
        "app.ts",
        'const url = "https://example.test"; // explanation\n\n/* one\ntwo */\nrun();',
      ),
      { comments: 3, nonblank: 4 },
    );
    NodeAssert.deepEqual(commentCounts("build.sh", '#!/bin/sh\nprintf "%s" "# tag"\n# note'), {
      comments: 1,
      nonblank: 2,
    });
    NodeAssert.deepEqual(commentCounts("index.html", "<!-- header -->\n<p>Hi</p>"), {
      comments: 1,
      nonblank: 2,
    });
  },
);
