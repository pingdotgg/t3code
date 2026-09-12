import { assert, it } from "@effect/vitest";

import {
  changeRequestHeadRef,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it("normalizes control characters and bounds error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(`  owner/repo\n\t${"x".repeat(300)}  `),
    `owner/repo ${"x".repeat(245)}`,
  );
});

it("names the change request head ref in each host's own namespace", () => {
  assert.strictEqual(changeRequestHeadRef("github", 42), "refs/pull/42/head");
  assert.strictEqual(changeRequestHeadRef("gitlab", 533), "refs/merge-requests/533/head");
});

it("has no change request head ref for hosts that publish none", () => {
  assert.strictEqual(changeRequestHeadRef("bitbucket", 42), null);
  assert.strictEqual(changeRequestHeadRef("azure-devops", 42), null);
  assert.strictEqual(changeRequestHeadRef("unknown", 42), null);
});
