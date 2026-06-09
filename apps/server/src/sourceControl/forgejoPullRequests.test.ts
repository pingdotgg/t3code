import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ForgejoPullRequestSchema,
  normalizeForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";

const decode = Schema.decodeUnknownEffect(ForgejoPullRequestSchema);

it.effect("normalizes a same-repository open PR", () =>
  Effect.gen(function* () {
    const raw = yield* decode({
      number: 42,
      title: "Add Forgejo provider",
      state: "open",
      merged: false,
      html_url: "https://codeberg.org/owner/repo/pulls/42",
      updated_at: "2026-01-02T00:00:00.000Z",
      base: { ref: "main", repo: { full_name: "owner/repo" } },
      head: { ref: "feature/forgejo", repo: { full_name: "owner/repo" } },
    });
    assert.deepStrictEqual(normalizeForgejoPullRequestRecord(raw), {
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/owner/repo/pulls/42",
      baseRefName: "main",
      headRefName: "feature/forgejo",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
    });
  }),
);

it.effect("marks merged PRs and cross-repository PRs", () =>
  Effect.gen(function* () {
    const raw = yield* decode({
      number: 7,
      title: "Fork PR",
      state: "closed",
      merged: true,
      html_url: "https://codeberg.org/owner/repo/pulls/7",
      base: { ref: "main", repo: { full_name: "owner/repo" } },
      head: {
        ref: "patch",
        repo: { full_name: "forker/repo", owner: { login: "forker" } },
      },
    });
    const record = normalizeForgejoPullRequestRecord(raw);
    assert.strictEqual(record.state, "merged");
    assert.strictEqual(record.isCrossRepository, true);
    assert.strictEqual(record.headRepositoryNameWithOwner, "forker/repo");
    assert.strictEqual(record.headRepositoryOwnerLogin, "forker");
  }),
);
