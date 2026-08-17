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

it("normalizes control characters and bounds error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(`  owner/repo\n\t${"x".repeat(300)}  `),
    `owner/repo ${"x".repeat(245)}`,
  );
});

it("keeps provider wrapper messages structural while sanitizing the transport cause", () => {
  const error = sourceControlProviderError({
    provider: "gitlab",
    operation: "listChangeRequests",
    cwd: "/repo",
    reference: "https://user:token@gitlab.example.test/group/repo?token=secret",
    error: new Error("raw upstream https://user:token@gitlab.example.test/group/repo?token=secret"),
  });

  assert.strictEqual(error.detail, "Source control provider operation failed.");
  assert.strictEqual(
    error.message,
    "Source control provider gitlab failed in listChangeRequests: Source control provider operation failed.",
  );
  assert.strictEqual(error.message.includes("token"), false);
  assert.deepStrictEqual(error.cause, {
    name: "Error",
    message: "raw upstream https://gitlab.example.test/group/repo",
  });
});

it("preserves finite rate-limit fields in the transport cause", () => {
  const error = sourceControlProviderError({
    provider: "bitbucket",
    operation: "listChangeRequests",
    cwd: "/repo",
    error: {
      _tag: "BitbucketResponseError",
      failureKind: "rate-limited",
      status: 429,
      retryAt: 121_000,
      detail: "Bitbucket returned HTTP 429.",
    },
  });

  assert.deepInclude(error.cause, {
    _tag: "BitbucketResponseError",
    failureKind: "rate-limited",
    status: 429,
    retryAt: 121_000,
  });
});
