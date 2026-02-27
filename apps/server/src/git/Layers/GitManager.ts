import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Path } from "effect";

import { GitManagerError } from "../Errors.ts";
import { GitManager, type GitManagerShape } from "../Services/GitManager.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

function gitManagerError(operation: string, detail: string, cause?: unknown): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitMessage(generated: { subject: string; body: string }): {
  subject: string;
  body: string;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
  };
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

function extractBranchFromRef(ref: string): string {
  const normalized = ref.trim();

  if (normalized.startsWith("refs/remotes/")) {
    const withoutPrefix = normalized.slice("refs/remotes/".length);
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash === -1) {
      return withoutPrefix.trim();
    }
    return withoutPrefix.slice(firstSlash + 1).trim();
  }

  const firstSlash = normalized.indexOf("/");
  if (firstSlash === -1) {
    return normalized;
  }
  return normalized.slice(firstSlash + 1).trim();
}

function toStatusOpenPr(pr: OpenPrInfo): {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
} {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
  };
}

export const makeGitManager = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const findOpenPr = (cwd: string, branch: string) =>
    gitHubCli
      .listOpenPullRequests({
        cwd,
        headBranch: branch,
        limit: 1,
      })
      .pipe(
        Effect.map((prs) => {
          const [first] = prs;
          if (!first) {
            return null;
          }
          return {
            number: first.number,
            title: first.title,
            url: first.url,
            baseRefName: first.baseRefName,
            headRefName: first.headRefName,
          } satisfies OpenPrInfo;
        }),
      );

  const resolveBaseBranch = (cwd: string, branch: string, upstreamRef: string | null) =>
    Effect.gen(function* () {
      const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
      if (configured) return configured;

      if (upstreamRef) {
        const upstreamBranch = extractBranchFromRef(upstreamRef);
        if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
          return upstreamBranch;
        }
      }

      const defaultFromGh = yield* gitHubCli
        .getDefaultBranch({ cwd })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (defaultFromGh) {
        return defaultFromGh;
      }

      return "main";
    });

  const runCommitStep = (cwd: string, branch: string | null, commitMessage?: string) =>
    Effect.gen(function* () {
      const context = yield* gitCore.prepareCommitContext(cwd);
      if (!context) {
        return { status: "skipped_no_changes" as const };
      }

      let generated = parseCustomCommitMessage(commitMessage ?? "");
      if (!generated) {
        generated = yield* textGeneration
          .generateCommitMessage({
            cwd,
            branch,
            stagedSummary: limitContext(context.stagedSummary, 8_000),
            stagedPatch: limitContext(context.stagedPatch, 50_000),
          })
          .pipe(Effect.map((result) => sanitizeCommitMessage(result)));
      }

      const { commitSha } = yield* gitCore.commit(cwd, generated.subject, generated.body);
      return {
        status: "created" as const,
        commitSha,
        subject: generated.subject,
      };
    });

  const runPrStep = (cwd: string, fallbackBranch: string | null) =>
    Effect.gen(function* () {
      const details = yield* gitCore.statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* gitManagerError(
          "runPrStep",
          "Cannot create a pull request from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* gitManagerError(
          "runPrStep",
          "Current branch has not been pushed. Push before creating a PR.",
        );
      }

      const existing = yield* findOpenPr(cwd, branch);
      if (existing) {
        return {
          status: "opened_existing" as const,
          url: existing.url,
          number: existing.number,
          baseBranch: existing.baseRefName,
          headBranch: existing.headRefName,
          title: existing.title,
        };
      }

      const baseBranch = yield* resolveBaseBranch(cwd, branch, details.upstreamRef);
      const rangeContext = yield* gitCore.readRangeContext(cwd, baseBranch);

      const generated = yield* textGeneration.generatePrContent({
        cwd,
        baseBranch,
        headBranch: branch,
        commitSummary: limitContext(rangeContext.commitSummary, 20_000),
        diffSummary: limitContext(rangeContext.diffSummary, 20_000),
        diffPatch: limitContext(rangeContext.diffPatch, 60_000),
      });

      const bodyFile = path.join(tempDir, `t3code-pr-body-${process.pid}-${randomUUID()}.md`);
      yield* fileSystem
        .writeFileString(bodyFile, generated.body)
        .pipe(
          Effect.mapError((cause) =>
            gitManagerError("runPrStep", "Failed to write pull request body temp file.", cause),
          ),
        );
      yield* gitHubCli
        .createPullRequest({
          cwd,
          baseBranch,
          headBranch: branch,
          title: generated.title,
          bodyFile,
        })
        .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))));

      const created = yield* findOpenPr(cwd, branch);
      if (!created) {
        return {
          status: "created" as const,
          baseBranch,
          headBranch: branch,
          title: generated.title,
        };
      }

      return {
        status: "created" as const,
        url: created.url,
        number: created.number,
        baseBranch: created.baseRefName,
        headBranch: created.headRefName,
        title: created.title,
      };
    });

  const status: GitManagerShape["status"] = Effect.fnUntraced(function* (input) {
    const details = yield* gitCore.statusDetails(input.cwd);

    const openPr =
      details.branch && details.hasUpstream
        ? yield* findOpenPr(input.cwd, details.branch).pipe(
            Effect.map((pr) => (pr ? toStatusOpenPr(pr) : null)),
            Effect.catch(() => Effect.succeed(null)),
          )
        : null;

    return {
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      openPr,
    };
  });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fnUntraced(
    function* (input) {
      const wantsPush = input.action !== "commit";
      const wantsPr = input.action === "commit_push_pr";

      const initialStatus = yield* gitCore.statusDetails(input.cwd);
      if (wantsPush && !initialStatus.branch) {
        return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
      }
      if (wantsPr && !initialStatus.branch) {
        return yield* gitManagerError(
          "runStackedAction",
          "Cannot create a pull request from detached HEAD.",
        );
      }

      const commit = yield* runCommitStep(input.cwd, initialStatus.branch, input.commitMessage);

      const push = wantsPush
        ? yield* gitCore.pushCurrentBranch(input.cwd, initialStatus.branch)
        : { status: "skipped_not_requested" as const };

      const pr = wantsPr
        ? yield* runPrStep(input.cwd, initialStatus.branch)
        : { status: "skipped_not_requested" as const };

      return {
        action: input.action,
        commit,
        push,
        pr,
      };
    },
  );

  return {
    status,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager);
