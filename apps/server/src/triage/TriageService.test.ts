import { assert, it } from "@effect/vitest";

import { pickSourceRef } from "./TriageService.ts";

const MAIN = "a1dc856ee61278d0199c36d4bcdef5fdea4d21fe\trefs/heads/main";

it("clones the server's release tag, peeling annotated tags to their commit", () => {
  assert.deepEqual(pickSourceRef(`${MAIN}\n7027b1f\trefs/tags/v0.1.1\n`, "0.1.1"), {
    ref: "v0.1.1",
    commit: "7027b1f",
  });
  assert.deepEqual(
    pickSourceRef(`${MAIN}\n1111111\trefs/tags/v0.1.1\n2222222\trefs/tags/v0.1.1^{}\n`, "0.1.1"),
    { ref: "v0.1.1", commit: "2222222" },
  );
});

it("falls back to main when the server's version has no tag", () => {
  assert.deepEqual(pickSourceRef(`${MAIN}\n`, "0.1.2-dev"), {
    ref: "main",
    commit: "a1dc856ee61278d0199c36d4bcdef5fdea4d21fe",
  });
  assert.isUndefined(pickSourceRef("", "0.1.1"));
});
