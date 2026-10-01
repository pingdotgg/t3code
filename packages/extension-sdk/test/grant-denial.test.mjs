import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { describeGrantDenial, grantDenialMessage } from "../dist/capabilities.js";

NodeTest.test("a broker capability denial names the grant and where to grant it", () => {
  NodeAssert.deepEqual(
    describeGrantDenial(new Error("API capability denied: t3.browser/sessions")),
    {
      grant: "t3.browser/sessions",
      message: "Needs permission t3.browser/sessions. Grant it in Settings → Extensions.",
    },
  );
  // The host wraps the broker's text: the grant still ends at its last name character.
  NodeAssert.equal(
    describeGrantDenial(
      new Error(
        "Failed to fetch (ExtensionOperationError: API capability denied: t3.ui/editor.open).",
      ),
    )?.grant,
    "t3.ui/editor.open",
  );
  NodeAssert.equal(
    describeGrantDenial("API capability denied: t3.agents/scan-sessions")?.grant,
    "t3.agents/scan-sessions",
  );
  NodeAssert.equal(
    grantDenialMessage("t3.browser/frames"),
    "Needs permission t3.browser/frames. Grant it in Settings → Extensions.",
  );
});

NodeTest.test("anything that is not a named capability denial is not a grant denial", () => {
  for (const error of [
    new Error("API capability denied"),
    new Error("Resource is outside installation grants"),
    new Error("API unavailable"),
    undefined,
    null,
    42,
  ])
    NodeAssert.equal(describeGrantDenial(error), null);
});
