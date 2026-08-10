import { assert, describe, it } from "vite-plus/test";

import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  codeReviewKey,
  migratePersistedCodeReviewState,
  selectCodeReview,
  type CodeReviewEntry,
} from "./codeReviewStore";

const REF = {
  environmentId: "env-1" as EnvironmentId,
  projectId: "proj-1" as ProjectId,
  provider: "github" as const,
  number: 42,
};

const ENTRY: CodeReviewEntry = {
  threadId: "thread-1" as ThreadId,
  startedAt: "2026-08-10T00:00:00.000Z",
};

describe("codeReviewKey", () => {
  it("scopes by project so the same PR number in two repos does not collide", () => {
    const other = { ...REF, projectId: "proj-2" as ProjectId };
    assert.notStrictEqual(codeReviewKey(REF), codeReviewKey(other));
  });

  it("scopes by provider", () => {
    assert.notStrictEqual(codeReviewKey(REF), codeReviewKey({ ...REF, provider: "gitlab" }));
  });

  it("scopes by environment", () => {
    assert.notStrictEqual(
      codeReviewKey(REF),
      codeReviewKey({ ...REF, environmentId: "env-2" as EnvironmentId }),
    );
  });
});

describe("selectCodeReview", () => {
  it("finds a recorded review", () => {
    const byKey = { [codeReviewKey(REF)]: ENTRY };
    assert.deepStrictEqual(selectCodeReview(byKey, REF), ENTRY);
  });

  it("returns null for an unreviewed pull request", () => {
    assert.strictEqual(selectCodeReview({}, REF), null);
  });

  it("returns null without a ref", () => {
    assert.strictEqual(selectCodeReview({ [codeReviewKey(REF)]: ENTRY }, null), null);
  });
});

describe("migratePersistedCodeReviewState", () => {
  it("keeps well-formed entries", () => {
    const migrated = migratePersistedCodeReviewState({ byKey: { "a:b:github:1": ENTRY } });
    assert.deepStrictEqual(migrated.byKey["a:b:github:1"], ENTRY);
  });

  it("drops entries with no thread id rather than rendering a dead chip", () => {
    const migrated = migratePersistedCodeReviewState({
      byKey: { "a:b:github:1": { startedAt: "2026-08-10T00:00:00.000Z" } },
    });
    assert.deepStrictEqual(migrated.byKey, {});
  });

  it("tolerates junk shapes", () => {
    assert.deepStrictEqual(migratePersistedCodeReviewState(null).byKey, {});
    assert.deepStrictEqual(migratePersistedCodeReviewState({}).byKey, {});
    assert.deepStrictEqual(migratePersistedCodeReviewState({ byKey: 7 }).byKey, {});
    assert.deepStrictEqual(
      migratePersistedCodeReviewState({ byKey: { "a:b:github:1": null } }).byKey,
      {},
    );
  });

  it("defaults a missing startedAt instead of dropping the review", () => {
    const migrated = migratePersistedCodeReviewState({
      byKey: { "a:b:github:1": { threadId: "thread-1" } },
    });
    assert.strictEqual(migrated.byKey["a:b:github:1"]?.threadId, "thread-1");
    assert.strictEqual(migrated.byKey["a:b:github:1"]?.startedAt, "");
  });
});
