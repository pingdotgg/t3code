import { assert, it } from "@effect/vitest";

import {
  sourceControlProviderError,
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

it("strips credentials from malformed embedded URLs", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue("remote failed at https://user:secret@[::1"),
    "remote failed at https://[::1",
  );
});

it("normalizes control characters and bounds error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(`  owner/repo\n\t${"x".repeat(300)}  `),
    `owner/repo ${"x".repeat(245)}`,
  );
});

it("wraps provider command errors with safe transport context and a bounded cause", () => {
  const cause = {
    _tag: "GitLabMergeRequestNotFoundError",
    command: "gh",
    detail:
      "Pull request not found at https://user:secret@example.test/org/repo/pull/42?token=secret#discussion.",
    reference: "42",
  };
  const error = sourceControlProviderError({
    provider: "github",
    operation: "getChangeRequest",
    cwd: "/repo",
    reference: "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    repository: "owner/repo\nbranch",
    error: cause,
  });

  assert.strictEqual(error.provider, "github");
  assert.strictEqual(error.operation, "getChangeRequest");
  assert.strictEqual(error.command, "gh");
  assert.strictEqual(error.cwd, "/repo");
  assert.strictEqual(error.reference, "https://example.test/org/repo/pull/42");
  assert.strictEqual(error.repository, "owner/repo branch");
  assert.strictEqual(
    error.detail,
    "Pull request not found at https://example.test/org/repo/pull/42",
  );
  assert.deepStrictEqual(error.cause, {
    _tag: "GitLabMergeRequestNotFoundError",
    command: "gh",
    detail: "Pull request not found at https://example.test/org/repo/pull/42",
    reference: "42",
  });
});

it("wraps plain Error instances without structured command fields", () => {
  const error = sourceControlProviderError({
    provider: "gitlab",
    operation: "listChangeRequests",
    cwd: "/repo",
    error: new Error("CLI failed."),
  });

  assert.strictEqual(error.command, undefined);
  assert.strictEqual(error.detail, "CLI failed.");
  assert.deepStrictEqual(error.cause, { name: "Error", message: "CLI failed." });
});

it("falls back when provider error context is missing", () => {
  const error = sourceControlProviderError({
    provider: "azure-devops",
    operation: "getDefaultBranch",
    cwd: "/repo",
    error: null,
  });

  assert.strictEqual(error.reference, undefined);
  assert.strictEqual(error.repository, undefined);
  assert.strictEqual(error.detail, "Source control provider operation failed.");
  assert.deepStrictEqual(error.cause, { message: "null" });
});
