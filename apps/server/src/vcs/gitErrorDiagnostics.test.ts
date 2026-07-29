import { assert, it } from "@effect/vitest";

import {
  classifyWorktreeCreateFailure,
  sanitizeGitErrorDiagnostic,
} from "./gitErrorDiagnostics.ts";

it("classifies expected worktree conflicts across stable Git stderr variants", () => {
  const cases = [
    ["fatal: a branch named 'feature/test' already exists", "worktree_branch_exists"],
    ["fatal: 'feature/test' is already used by worktree at '/private/repo'", "worktree_ref_in_use"],
    ["fatal: '/private/worktree' already exists", "worktree_path_exists"],
    [
      "fatal: '/private/worktree' is a missing but already registered worktree; use 'add -f' to override",
      "worktree_registration_conflict",
    ],
    [
      "fatal: '/private/worktree' is a missing but locked worktree; use 'add -f -f' to override",
      "worktree_registration_conflict",
    ],
  ] as const;

  for (const [stderr, expected] of cases) {
    assert.equal(classifyWorktreeCreateFailure(stderr).failureKind, expected);
  }
});

it("redacts credentials and key material and bounds unknown Git diagnostics", () => {
  const secrets = [
    "user-password",
    "bearer-secret",
    "token-secret",
    "private-key-material",
    "0123456789abcdef0123456789abcdef0123456789abcdef",
  ];
  const stderr = [
    "fatal: https://user:user-password@example.test/private/repo.git failed",
    "Authorization: Bearer bearer-secret",
    "token=token-secret",
    "-----BEGIN PRIVATE KEY-----",
    "private-key-material",
    "-----END PRIVATE KEY-----",
    secrets[4],
    "x".repeat(2_000),
  ].join("\n");

  const diagnostic = sanitizeGitErrorDiagnostic(stderr);
  const classified = classifyWorktreeCreateFailure(stderr);

  assert.isAtMost(diagnostic.length, 512);
  assert.equal(classified.failureKind, "unknown");
  assert.equal(classified.safeDiagnostic, diagnostic);
  for (const secret of secrets) {
    assert.notInclude(diagnostic, secret);
  }
  assert.notInclude(diagnostic, "\n");
});
