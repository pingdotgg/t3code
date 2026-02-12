import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  gitRunStackedActionInputSchema,
  gitRunStackedActionResultSchema,
  gitStatusInputSchema,
  gitStatusResultSchema,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusInput,
  type GitStatusResult,
} from "@t3tools/contracts";

import type {
  CommitMessageGenerationResult,
  PrContentGenerationResult,
  TextGenerationService,
} from "./coreServices";
import { CodexTextGenerator } from "./codexTextGenerator";
import { type ProcessRunOptions, runProcess } from "./processRunner";

interface GitStatusDetails extends GitStatusResult {
  upstreamRef: string | null;
}

interface GitManagerDeps {
  runProcess?: (
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ) => Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>;
  textGenerator?: TextGenerationService;
}

interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

function parseOpenPrList(raw: unknown): OpenPrInfo[] {
  if (!Array.isArray(raw)) return [];

  const parsed: OpenPrInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.number;
    const title = record.title;
    const url = record.url;
    const baseRefName = record.baseRefName;
    const headRefName = record.headRefName;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0
    ) {
      continue;
    }
    if (
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof baseRefName !== "string" ||
      typeof headRefName !== "string"
    ) {
      continue;
    }
    parsed.push({
      number,
      title,
      url,
      baseRefName,
      headRefName,
    });
  }
  return parsed;
}

function trimStdout(value: string): string {
  return value.trim();
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitMessage(
  generated: CommitMessageGenerationResult,
): CommitMessageGenerationResult {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject =
    subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
  };
}

function extractBranchFromRef(ref: string): string {
  const normalized = ref.trim();
  const afterSlash = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  return afterSlash.trim();
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function asCommandNotFound(
  command: string,
  error: unknown,
): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!error.message.includes(`Command not found: ${command}`)) return undefined;
  if (command === "gh") {
    return new Error("GitHub CLI (`gh`) is required but not available on PATH.");
  }
  if (command === "codex") {
    return new Error("Codex CLI (`codex`) is required but not available on PATH.");
  }
  if (command === "git") {
    return new Error("Git is required but not available on PATH.");
  }
  return new Error(`${command} is required but not available on PATH.`);
}

function normalizeGitHubAuthError(error: unknown): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  const lower = error.message.toLowerCase();
  if (
    lower.includes("authentication failed") ||
    lower.includes("not logged in") ||
    lower.includes("gh auth login") ||
    lower.includes("no oauth token")
  ) {
    return new Error("GitHub CLI is not authenticated. Run `gh auth login` and retry.");
  }
  return undefined;
}

function normalizeNotGitRepoError(error: unknown): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message.toLowerCase().includes("not a git repository")) {
    return new Error("Current folder is not a git repository.");
  }
  return undefined;
}

export class GitManager {
  private readonly run: NonNullable<GitManagerDeps["runProcess"]>;
  private readonly textGenerator: TextGenerationService;

  constructor(deps: GitManagerDeps = {}) {
    this.run = deps.runProcess ?? runProcess;
    this.textGenerator = deps.textGenerator ?? new CodexTextGenerator();
  }

  async status(raw: GitStatusInput): Promise<GitStatusResult> {
    const input = gitStatusInputSchema.parse(raw);
    const details = await this.readStatusDetails(input.cwd);
    return gitStatusResultSchema.parse({
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
    });
  }

  async runStackedAction(
    raw: GitRunStackedActionInput,
  ): Promise<GitRunStackedActionResult> {
    const input = gitRunStackedActionInputSchema.parse(raw);
    const wantsPush = input.action !== "commit";
    const wantsPr = input.action === "commit_push_pr";

    const initialStatus = await this.readStatusDetails(input.cwd);
    if (wantsPush && !initialStatus.branch) {
      throw new Error("Cannot push from detached HEAD.");
    }
    if (wantsPr && !initialStatus.branch) {
      throw new Error("Cannot create a pull request from detached HEAD.");
    }

    const commit = await this.runCommitStep(input.cwd, initialStatus.branch);

    const push = wantsPush
      ? await this.runPushStep(input.cwd, initialStatus.branch)
      : { status: "skipped_not_requested" as const };

    const pr = wantsPr
      ? await this.runPrStep(input.cwd, initialStatus.branch)
      : { status: "skipped_not_requested" as const };

    return gitRunStackedActionResultSchema.parse({
      action: input.action,
      commit,
      push,
      pr,
    });
  }

  private async readStatusDetails(cwd: string): Promise<GitStatusDetails> {
    let stdout = "";
    try {
      stdout = await this.runGitStdout(cwd, ["status", "--porcelain=2", "--branch"]);
    } catch (error) {
      throw (
        asCommandNotFound("git", error) ??
        normalizeNotGitRepoError(error) ??
        (error instanceof Error ? error : new Error("Failed to read git status."))
      );
    }

    let branch: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let hasWorkingTreeChanges = false;

    for (const line of stdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        branch = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
      }
    }

    return {
      branch,
      upstreamRef,
      hasWorkingTreeChanges,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
    };
  }

  private async runCommitStep(
    cwd: string,
    branch: string | null,
  ): Promise<{
    status: "created" | "skipped_no_changes";
    commitSha?: string | undefined;
    subject?: string | undefined;
  }> {
    await this.runGit(cwd, ["add", "-A"]);
    const stagedSummary = await this.runGitStdout(cwd, [
      "diff",
      "--cached",
      "--name-status",
    ]);
    if (trimStdout(stagedSummary).length === 0) {
      return { status: "skipped_no_changes" };
    }

    const stagedPatch = await this.runGitStdout(cwd, [
      "diff",
      "--cached",
      "--patch",
      "--minimal",
    ]);

    let generated: CommitMessageGenerationResult;
    try {
      generated = sanitizeCommitMessage(
        await this.textGenerator.generateCommitMessage({
          cwd,
          branch,
          stagedSummary: limitContext(stagedSummary, 8_000),
          stagedPatch: limitContext(stagedPatch, 50_000),
        }),
      );
    } catch (error) {
      throw asCommandNotFound("codex", error) ?? error;
    }

    const commitArgs = ["commit", "-m", generated.subject];
    if (generated.body.length > 0) {
      commitArgs.push("-m", generated.body);
    }
    await this.runGit(cwd, commitArgs);

    const commitSha = trimStdout(await this.runGitStdout(cwd, ["rev-parse", "HEAD"]));
    return {
      status: "created",
      commitSha,
      subject: generated.subject,
    };
  }

  private async runPushStep(
    cwd: string,
    fallbackBranch: string | null,
  ): Promise<{
    status: "pushed" | "skipped_not_requested" | "skipped_up_to_date";
    branch?: string | undefined;
    upstreamBranch?: string | undefined;
    setUpstream?: boolean | undefined;
  }> {
    const details = await this.readStatusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      throw new Error("Cannot push from detached HEAD.");
    }

    if (details.hasUpstream && details.aheadCount === 0) {
      return {
        status: "skipped_up_to_date",
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      };
    }

    if (!details.hasUpstream) {
      await this.runGit(cwd, ["push", "-u", "origin", branch]);
      return {
        status: "pushed",
        branch,
        upstreamBranch: `origin/${branch}`,
        setUpstream: true,
      };
    }

    await this.runGit(cwd, ["push"]);
    return {
      status: "pushed",
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  }

  private async runPrStep(
    cwd: string,
    fallbackBranch: string | null,
  ): Promise<{
    status: "created" | "opened_existing" | "skipped_not_requested";
    url?: string | undefined;
    number?: number | undefined;
    baseBranch?: string | undefined;
    headBranch?: string | undefined;
    title?: string | undefined;
  }> {
    const details = await this.readStatusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      throw new Error("Cannot create a pull request from detached HEAD.");
    }
    if (!details.hasUpstream) {
      throw new Error("Current branch has not been pushed. Push before creating a PR.");
    }

    const existing = await this.findOpenPr(cwd, branch);
    if (existing) {
      await this.openPrInBrowser(cwd, branch);
      return {
        status: "opened_existing",
        url: existing.url,
        number: existing.number,
        baseBranch: existing.baseRefName,
        headBranch: existing.headRefName,
        title: existing.title,
      };
    }

    const baseBranch = await this.resolveBaseBranch(cwd, branch, details.upstreamRef);
    const commitSummary = await this.runGitStdout(cwd, [
      "log",
      "--oneline",
      `${baseBranch}..HEAD`,
    ]);
    const diffSummary = await this.runGitStdout(cwd, [
      "diff",
      "--stat",
      `${baseBranch}..HEAD`,
    ]);
    const diffPatch = await this.runGitStdout(cwd, [
      "diff",
      "--patch",
      "--minimal",
      `${baseBranch}..HEAD`,
    ]);

    let generated: PrContentGenerationResult;
    try {
      generated = await this.textGenerator.generatePrContent({
        cwd,
        baseBranch,
        headBranch: branch,
        commitSummary: limitContext(commitSummary, 20_000),
        diffSummary: limitContext(diffSummary, 20_000),
        diffPatch: limitContext(diffPatch, 60_000),
      });
    } catch (error) {
      throw asCommandNotFound("codex", error) ?? error;
    }

    const bodyFile = path.join(
      os.tmpdir(),
      `t3code-pr-body-${process.pid}-${randomUUID()}.md`,
    );
    await fs.writeFile(bodyFile, generated.body, "utf8");

    try {
      await this.runGh(cwd, [
        "pr",
        "create",
        "--base",
        baseBranch,
        "--head",
        branch,
        "--title",
        generated.title,
        "--body-file",
        bodyFile,
      ]);
    } finally {
      try {
        await fs.unlink(bodyFile);
      } catch {
        // Best-effort cleanup.
      }
    }

    const created = await this.findOpenPr(cwd, branch);
    await this.openPrInBrowser(cwd, branch);

    if (!created) {
      return {
        status: "created",
        baseBranch,
        headBranch: branch,
        title: generated.title,
      };
    }

    return {
      status: "created",
      url: created.url,
      number: created.number,
      baseBranch: created.baseRefName,
      headBranch: created.headRefName,
      title: created.title,
    };
  }

  private async openPrInBrowser(cwd: string, branch: string): Promise<void> {
    try {
      await this.runGh(cwd, ["pr", "view", branch, "--web"]);
    } catch {
      // Opening the browser is best-effort.
    }
  }

  private async findOpenPr(
    cwd: string,
    branch: string,
  ): Promise<OpenPrInfo | null> {
    const stdout = await this.runGhStdout(cwd, [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "number,title,url,baseRefName,headRefName",
    ]);

    const raw = trimStdout(stdout);
    if (raw.length === 0) return null;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error("GitHub CLI returned invalid PR list JSON.");
    }

    const parsed = parseOpenPrList(parsedJson);
    return parsed[0] ?? null;
  }

  private async resolveBaseBranch(
    cwd: string,
    branch: string,
    upstreamRef: string | null,
  ): Promise<string> {
    const mergeBaseConfig = await this.runGitStdout(
      cwd,
      ["config", "--get", `branch.${branch}.gh-merge-base`],
      true,
    );
    const configured = trimStdout(mergeBaseConfig);
    if (configured.length > 0) return configured;

    if (upstreamRef) {
      const upstreamBranch = extractBranchFromRef(upstreamRef);
      if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
        return upstreamBranch;
      }
    }

    try {
      const ghDefault = await this.runGhStdout(cwd, [
        "repo",
        "view",
        "--json",
        "defaultBranchRef",
        "--jq",
        ".defaultBranchRef.name",
      ]);
      const defaultBranch = trimStdout(ghDefault);
      if (defaultBranch.length > 0) return defaultBranch;
    } catch {
      // Fall through to deterministic fallback.
    }

    return "main";
  }

  private async runGit(
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Promise<void> {
    try {
      await this.run("git", args, {
        cwd,
        allowNonZeroExit,
      });
    } catch (error) {
      throw (
        asCommandNotFound("git", error) ??
        normalizeNotGitRepoError(error) ??
        (error instanceof Error ? error : new Error("Git command failed."))
      );
    }
  }

  private async runGitStdout(
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Promise<string> {
    try {
      const result = await this.run("git", args, {
        cwd,
        allowNonZeroExit,
      });
      return result.stdout;
    } catch (error) {
      throw (
        asCommandNotFound("git", error) ??
        normalizeNotGitRepoError(error) ??
        (error instanceof Error ? error : new Error("Git command failed."))
      );
    }
  }

  private async runGh(cwd: string, args: readonly string[]): Promise<void> {
    try {
      await this.run("gh", args, { cwd });
    } catch (error) {
      throw (
        asCommandNotFound("gh", error) ??
        normalizeGitHubAuthError(error) ??
        (error instanceof Error ? error : new Error("GitHub CLI command failed."))
      );
    }
  }

  private async runGhStdout(cwd: string, args: readonly string[]): Promise<string> {
    try {
      const result = await this.run("gh", args, { cwd });
      return result.stdout;
    } catch (error) {
      throw (
        asCommandNotFound("gh", error) ??
        normalizeGitHubAuthError(error) ??
        (error instanceof Error ? error : new Error("GitHub CLI command failed."))
      );
    }
  }
}
