import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  gitRunStackedActionInputSchema,
  gitRunStackedActionResultSchema,
  gitStatusInputSchema,
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
import { GitCoreService } from "./git";
import {
  type ProcessRunOptions,
  type ProcessRunResult,
  runProcess,
} from "./processRunner";

const GH_CLI_TIMEOUT_MS = 30_000;

interface GitManagerDeps {
  runProcess?: (
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ) => Promise<ProcessRunResult>;
  textGenerator?: TextGenerationService;
  gitCore?: GitCoreService;
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

export class GitManager {
  private readonly run: NonNullable<GitManagerDeps["runProcess"]>;
  private readonly textGenerator: TextGenerationService;
  private readonly gitCore: GitCoreService;

  constructor(deps: GitManagerDeps = {}) {
    this.run = deps.runProcess ?? runProcess;
    this.textGenerator = deps.textGenerator ?? new CodexTextGenerator();
    this.gitCore = deps.gitCore ?? new GitCoreService();
  }

  async status(raw: GitStatusInput): Promise<GitStatusResult> {
    const input = gitStatusInputSchema.parse(raw);
    const details = await this.gitCore.statusDetails(input.cwd);

    let openPr: ReturnType<typeof toStatusOpenPr> | null = null;
    if (details.branch && details.hasUpstream) {
      try {
        const existing = await this.findOpenPr(input.cwd, details.branch);
        if (existing) {
          openPr = toStatusOpenPr(existing);
        }
      } catch {
        // PR lookup is best-effort for status rendering.
      }
    }

    return {
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      openPr,
    };
  }

  async runStackedAction(
    raw: GitRunStackedActionInput,
  ): Promise<GitRunStackedActionResult> {
    const input = gitRunStackedActionInputSchema.parse(raw);
    const wantsPush = input.action !== "commit";
    const wantsPr = input.action === "commit_push_pr";

    const initialStatus = await this.gitCore.statusDetails(input.cwd);
    if (wantsPush && !initialStatus.branch) {
      throw new Error("Cannot push from detached HEAD.");
    }
    if (wantsPr && !initialStatus.branch) {
      throw new Error("Cannot create a pull request from detached HEAD.");
    }

    const commit = await this.runCommitStep(input.cwd, initialStatus.branch);

    const push = wantsPush
      ? await this.gitCore.pushCurrentBranch(input.cwd, initialStatus.branch)
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

  private async runCommitStep(
    cwd: string,
    branch: string | null,
  ): Promise<{
    status: "created" | "skipped_no_changes";
    commitSha?: string | undefined;
    subject?: string | undefined;
  }> {
    const context = await this.gitCore.prepareCommitContext(cwd);
    if (!context) {
      return { status: "skipped_no_changes" };
    }

    let generated: CommitMessageGenerationResult;
    try {
      generated = sanitizeCommitMessage(
        await this.textGenerator.generateCommitMessage({
          cwd,
          branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
        }),
      );
    } catch (error) {
      throw asCommandNotFound("codex", error) ?? error;
    }

    const { commitSha } = await this.gitCore.commit(cwd, generated.subject, generated.body);
    return {
      status: "created",
      commitSha,
      subject: generated.subject,
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
    const details = await this.gitCore.statusDetails(cwd);
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
    const rangeContext = await this.gitCore.readRangeContext(cwd, baseBranch);

    let generated: PrContentGenerationResult;
    try {
      generated = await this.textGenerator.generatePrContent({
        cwd,
        baseBranch,
        headBranch: branch,
        commitSummary: limitContext(rangeContext.commitSummary, 20_000),
        diffSummary: limitContext(rangeContext.diffSummary, 20_000),
        diffPatch: limitContext(rangeContext.diffPatch, 60_000),
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
    const configured = await this.gitCore.readConfigValue(
      cwd,
      `branch.${branch}.gh-merge-base`,
    );
    if (configured) return configured;

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

  private async runGh(cwd: string, args: readonly string[]): Promise<void> {
    await this.runGhCommand(cwd, args);
  }

  private async runGhStdout(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.runGhCommand(cwd, args);
    return result.stdout;
  }

  private async runGhCommand(
    cwd: string,
    args: readonly string[],
  ): Promise<ProcessRunResult> {
    try {
      return await this.run("gh", args, {
        cwd,
        timeoutMs: GH_CLI_TIMEOUT_MS,
      });
    } catch (error) {
      throw (
        asCommandNotFound("gh", error) ??
        normalizeGitHubAuthError(error) ??
        (error instanceof Error ? error : new Error("GitHub CLI command failed."))
      );
    }
  }
}
