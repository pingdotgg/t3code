import { assert, it } from "@effect/vitest";

import {
  repositoryPathFromRemoteUrl,
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

it("keeps the spelling of an Entire clone URL's repository path", () => {
  assert.strictEqual(
    repositoryPathFromRemoteUrl("entire://aws-us-east-2.entire.io/gh/Acme/Web.git"),
    "gh/Acme/Web",
  );
});
