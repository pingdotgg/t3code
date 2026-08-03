import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { TextGenerationError, type SourceControlWritingStyleSettings } from "@t3tools/contracts";

import {
  formatCommitMessage,
  generateCommitMessage,
  readCommitMessageContext,
  readRecentCommitSubjects,
  resolveCommitStylePolicy,
  STAGED_PATCH_MAX_CHARS,
  STAGED_SUMMARY_MAX_CHARS,
  styleNeedsRecentSubjects,
  toGeneratedCommitMessage,
  type CommitMessageContext,
} from "./WorkingCopyCommitMessage.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import {
  git,
  makeTestRepository,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

const style = (
  overrides: Partial<SourceControlWritingStyleSettings>,
): SourceControlWritingStyleSettings => ({
  mode: "repo_conventions",
  customInstructions: "",
  followChangeRequestTemplates: true,
  ...overrides,
});

// ─── Context reads (real repositories) ──────────────────────────────────────

it.layer(WorkingCopyTestLayer)("readCommitMessageContext", (it) => {
  it.effect("answers null when nothing is staged, even with a dirty worktree", () =>
    Effect.gen(function* () {
      // The load-bearing rule: generation never silently widens to the
      // unstaged tree. `b.ts` is modified and untracked work exists; both are
      // invisible to the prompt.
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* git(repo.cwd, ["add", "b.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* writeFile(repo.cwd, "b.ts", "b changed\n");
      yield* writeFile(repo.cwd, "untracked.ts", "new\n");

      const context = yield* readCommitMessageContext(repo.git, {
        amend: false,
        wantsRecentSubjects: false,
      });

      assert.strictEqual(context, null);
    }),
  );

  it.effect("reads the staged side only", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* git(repo.cwd, ["add", "a.ts", "b.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);

      yield* writeFile(repo.cwd, "a.ts", "a staged\n");
      yield* writeFile(repo.cwd, "b.ts", "b unstaged\n");
      yield* stagePaths(repo.git, ["a.ts"]);

      const context = yield* readCommitMessageContext(repo.git, {
        amend: false,
        wantsRecentSubjects: false,
      });

      assert.isNotNull(context);
      assert.include(context.stagedSummary, "a.ts");
      assert.notInclude(context.stagedSummary, "b.ts");
      assert.include(context.stagedPatch, "a staged");
      assert.notInclude(context.stagedPatch, "b unstaged");
      assert.strictEqual(context.branch, "main");
      assert.deepStrictEqual(context.recentSubjects, []);
    }),
  );

  it.effect("does not touch the index while reading", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* git(repo.cwd, ["add", "a.ts", "b.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* writeFile(repo.cwd, "a.ts", "a staged\n");
      yield* writeFile(repo.cwd, "b.ts", "b unstaged\n");
      yield* stagePaths(repo.git, ["a.ts"]);

      yield* readCommitMessageContext(repo.git, { amend: false, wantsRecentSubjects: true });

      const stagedAfter = yield* git(repo.cwd, ["diff", "--cached", "--name-only"]);
      assert.deepStrictEqual(
        stagedAfter
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        ["a.ts"],
      );
    }),
  );

  it.effect("amend spans the commit being rewritten plus the index", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "root.ts", "root\n");
      yield* git(repo.cwd, ["add", "root.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "root"]);
      yield* writeFile(repo.cwd, "first.ts", "first\n");
      yield* git(repo.cwd, ["add", "first.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "the commit being amended"]);
      yield* writeFile(repo.cwd, "second.ts", "second\n");
      yield* stagePaths(repo.git, ["second.ts"]);

      const amended = yield* readCommitMessageContext(repo.git, {
        amend: true,
        wantsRecentSubjects: false,
      });
      const plain = yield* readCommitMessageContext(repo.git, {
        amend: false,
        wantsRecentSubjects: false,
      });

      assert.isNotNull(amended);
      assert.include(amended.stagedSummary, "first.ts");
      assert.include(amended.stagedSummary, "second.ts");
      // Without the amend base the model would only ever see the new file and
      // would rewrite the subject as if the amended work never happened.
      assert.isNotNull(plain);
      assert.notInclude(plain.stagedSummary, "first.ts");
      assert.include(plain.stagedSummary, "second.ts");
      assert.notInclude(amended.stagedSummary, "root.ts");
    }),
  );

  it.effect("amending a root commit falls back to the empty tree", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "only.ts", "only\n");
      yield* git(repo.cwd, ["add", "only.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "root"]);

      const context = yield* readCommitMessageContext(repo.git, {
        amend: true,
        wantsRecentSubjects: false,
      });

      assert.isNotNull(context);
      assert.include(context.stagedSummary, "only.ts");
    }),
  );

  it.effect("an empty amend answers null rather than describing nothing", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "one"]);
      // An empty commit on top: amending it against its parent is a no-op diff.
      yield* git(repo.cwd, ["commit", "--allow-empty", "-m", "empty"]);

      const context = yield* readCommitMessageContext(repo.git, {
        amend: true,
        wantsRecentSubjects: false,
      });

      assert.strictEqual(context, null);
    }),
  );

  it.effect("reads recent subjects only when the style asks for them", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "feat: the first thing"]);
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* stagePaths(repo.git, ["b.ts"]);

      const withSubjects = yield* readCommitMessageContext(repo.git, {
        amend: false,
        wantsRecentSubjects: true,
      });
      const withoutSubjects = yield* readCommitMessageContext(repo.git, {
        amend: false,
        wantsRecentSubjects: false,
      });

      assert.deepStrictEqual(withSubjects?.recentSubjects, ["feat: the first thing"]);
      assert.deepStrictEqual(withoutSubjects?.recentSubjects, []);
    }),
  );

  it.effect("recent subjects on an empty repository are an empty list, not a failure", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      const subjects = yield* readRecentCommitSubjects(repo.git);

      assert.deepStrictEqual(subjects, []);
    }),
  );

  it.effect("a detached HEAD reports a null branch", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      const head = (yield* git(repo.cwd, ["rev-parse", "HEAD"])).trim();
      yield* git(repo.cwd, ["checkout", "--detach", head]);
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* stagePaths(repo.git, ["b.ts"]);

      const context = yield* readCommitMessageContext(repo.git, {
        amend: false,
        wantsRecentSubjects: false,
      });

      assert.strictEqual(context?.branch, null);
    }),
  );
});

// ─── Pure pieces ────────────────────────────────────────────────────────────

describe("resolveCommitStylePolicy", () => {
  it("maps conventional_commits to the shared preset", () => {
    const policy = resolveCommitStylePolicy(style({ mode: "conventional_commits" }), []);
    assert.strictEqual(policy.kind, "conventional_commits");
    assert.include(policy.commitInstructions ?? "", "Conventional Commits");
  });

  it("carries custom instructions through verbatim", () => {
    const policy = resolveCommitStylePolicy(
      style({ mode: "custom", customInstructions: "Always mention the ticket id." }),
      ["ignored"],
    );
    assert.strictEqual(policy.kind, "custom");
    assert.strictEqual(policy.commitInstructions, "Always mention the ticket id.");
  });

  it("custom with no instructions is still a custom policy with nothing attached", () => {
    const policy = resolveCommitStylePolicy(style({ mode: "custom", customInstructions: "" }), []);
    assert.strictEqual(policy.kind, "custom");
    assert.isUndefined(policy.commitInstructions);
  });

  it("repo_conventions appends the recent subjects as examples", () => {
    const policy = resolveCommitStylePolicy(style({ mode: "repo_conventions" }), [
      "feat: a",
      "fix: b",
    ]);
    assert.strictEqual(policy.kind, "repo_conventions");
    assert.include(policy.commitInstructions ?? "", "Recent commit subjects from this repository:");
    assert.include(policy.commitInstructions ?? "", "feat: a");
    assert.include(policy.commitInstructions ?? "", "fix: b");
  });

  it("repo_conventions with no history is the bare preset", () => {
    const policy = resolveCommitStylePolicy(style({ mode: "repo_conventions" }), []);
    assert.notInclude(policy.commitInstructions ?? "", "Recent commit subjects");
  });

  it("only repo_conventions needs history read for it", () => {
    assert.isTrue(styleNeedsRecentSubjects(style({ mode: "repo_conventions" })));
    assert.isFalse(styleNeedsRecentSubjects(style({ mode: "conventional_commits" })));
    assert.isFalse(styleNeedsRecentSubjects(style({ mode: "custom" })));
  });
});

describe("toGeneratedCommitMessage", () => {
  it("keeps the first line only, drops a trailing period, and joins with a blank line", () => {
    const result = toGeneratedCommitMessage({
      subject: "  Add the thing.  \nstray second line",
      body: "\n- one\n- two\n\n",
    });
    assert.strictEqual(result.subject, "Add the thing");
    assert.strictEqual(result.body, "- one\n- two");
    assert.strictEqual(result.message, "Add the thing\n\n- one\n- two");
  });

  it("a body-less message is just the subject", () => {
    const result = toGeneratedCommitMessage({ subject: "Add the thing", body: "   " });
    assert.strictEqual(result.body, "");
    assert.strictEqual(result.message, "Add the thing");
  });

  it("an empty subject falls back rather than producing an empty commit message", () => {
    const result = toGeneratedCommitMessage({ subject: "   ", body: "" });
    assert.strictEqual(result.subject, "Update project files");
    assert.strictEqual(result.message, "Update project files");
  });

  it("clamps an over-long subject to 72 characters", () => {
    const result = toGeneratedCommitMessage({ subject: "x".repeat(200), body: "" });
    assert.lengthOf(result.subject, 72);
  });

  it("formatCommitMessage never emits a trailing blank line for an empty body", () => {
    assert.strictEqual(formatCommitMessage("subject", "\n\n"), "subject");
  });
});

// ─── The model call ─────────────────────────────────────────────────────────

const context = (overrides: Partial<CommitMessageContext> = {}): CommitMessageContext => ({
  branch: "main",
  stagedSummary: "M\tsrc/a.ts",
  stagedPatch: "diff --git a/src/a.ts b/src/a.ts\n",
  recentSubjects: [],
  ...overrides,
});

it.effect("passes the resolved policy and budgeted context to the generator", () =>
  Effect.gen(function* () {
    const calls: Array<Record<string, unknown>> = [];
    const result = yield* generateCommitMessage(
      {
        generateCommitMessage: (input) =>
          Effect.sync(() => {
            calls.push(input as unknown as Record<string, unknown>);
            return { subject: "Add a thing.", body: "why" };
          }),
      },
      {
        cwd: "/work/proj",
        context: context({
          stagedSummary: "s".repeat(STAGED_SUMMARY_MAX_CHARS + 10),
          stagedPatch: "p".repeat(STAGED_PATCH_MAX_CHARS + 10),
          recentSubjects: ["feat: earlier"],
        }),
        style: style({ mode: "repo_conventions" }),
        modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
      },
    );

    assert.strictEqual(calls.length, 1);
    const call = calls[0] as {
      readonly stagedSummary: string;
      readonly stagedPatch: string;
      readonly policy: { readonly commitInstructions?: string };
      readonly branch: string | null;
    };
    // Truncation marker, not a hard cut: the model must know it saw a prefix.
    assert.isTrue(call.stagedSummary.endsWith("[truncated]"));
    assert.isTrue(call.stagedPatch.endsWith("[truncated]"));
    assert.include(call.policy.commitInstructions ?? "", "feat: earlier");
    assert.strictEqual(call.branch, "main");
    assert.deepStrictEqual(result, {
      subject: "Add a thing",
      body: "why",
      message: "Add a thing\n\nwhy",
    });
  }),
);

it.effect("propagates a TextGenerationError unchanged", () =>
  Effect.gen(function* () {
    const failure = yield* generateCommitMessage(
      {
        generateCommitMessage: () =>
          new TextGenerationError({
            operation: "generateCommitMessage",
            detail: "Codex CLI (`codex`) is required but not available on PATH.",
          }),
      },
      {
        cwd: "/work/proj",
        context: context(),
        style: style({ mode: "conventional_commits" }),
        modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
      },
    ).pipe(Effect.flip);

    assert.instanceOf(failure, TextGenerationError);
    assert.include(failure.detail, "not available on PATH");
  }),
);
