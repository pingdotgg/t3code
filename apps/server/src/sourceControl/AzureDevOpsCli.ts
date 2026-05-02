import { readFile } from "node:fs/promises";

import { Context, Effect, Layer, Result, Schema, SchemaIssue } from "effect";
import { TrimmedNonEmptyString } from "@t3tools/contracts";

import type { ProcessRunResult } from "../processRunner.ts";
import { runProcess } from "../processRunner.ts";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  formatAzureDevOpsJsonDecodeError,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export class AzureDevOpsCliError extends Schema.TaggedErrorClass<AzureDevOpsCliError>()(
  "AzureDevOpsCliError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export interface AzureDevOpsRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface AzureDevOpsCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<ProcessRunResult, AzureDevOpsCliError>;

  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>, AzureDevOpsCliError>;

  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<NormalizedAzureDevOpsPullRequestRecord, AzureDevOpsCliError>;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsCliError>;

  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, AzureDevOpsCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<string | null, AzureDevOpsCliError>;

  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<void, AzureDevOpsCliError>;
}

export class AzureDevOpsCli extends Context.Service<AzureDevOpsCli, AzureDevOpsCliShape>()(
  "t3/source-control/AzureDevOpsCli",
) {}

function normalizeAzureDevOpsCliError(
  operation: "execute" | "readBodyFile",
  error: unknown,
): AzureDevOpsCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: az")) {
      return new AzureDevOpsCliError({
        operation,
        detail:
          "Azure CLI (`az`) with the Azure DevOps extension is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("az devops login") ||
      lower.includes("please run az login") ||
      lower.includes("not logged in") ||
      lower.includes("authentication failed") ||
      lower.includes("unauthorized")
    ) {
      return new AzureDevOpsCliError({
        operation,
        detail: "Azure DevOps CLI is not authenticated. Run `az devops login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("pull request") &&
      (lower.includes("not found") || lower.includes("does not exist"))
    ) {
      return new AzureDevOpsCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        cause: error,
      });
    }

    return new AzureDevOpsCliError({
      operation,
      detail: `Azure DevOps CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new AzureDevOpsCliError({
    operation,
    detail: "Azure DevOps CLI command failed.",
    cause: error,
  });
}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pullrequest|pull-request|pull|_pulls?)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function normalizeSourceBranch(headSelector: string): string {
  const trimmed = headSelector.trim();
  const ownerSelector = /^([^:/\s]+):(.+)$/u.exec(trimmed);
  return ownerSelector?.[2]?.trim() ?? trimmed;
}

function toAzureStatus(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "active";
    case "closed":
      return "abandoned";
    case "merged":
      return "completed";
    case "all":
      return "all";
  }
}

const RawAzureDevOpsRepositorySchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  webUrl: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  project: Schema.optional(
    Schema.Struct({
      name: TrimmedNonEmptyString,
    }),
  ),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
});

function normalizeDefaultBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^refs\/heads\//, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawAzureDevOpsRepositorySchema>,
): AzureDevOpsRepositoryCloneUrls {
  const projectName = raw.project?.name.trim();
  return {
    nameWithOwner: projectName ? `${projectName}/${raw.name}` : raw.name,
    url: raw.remoteUrl,
    sshUrl: raw.sshUrl,
  };
}

function decodeAzureDevOpsJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "getRepositoryCloneUrls" | "getDefaultBranch",
  invalidDetail: string,
): Effect.Effect<S["Type"], AzureDevOpsCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new AzureDevOpsCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

export const make = Effect.sync(() => {
  const execute: AzureDevOpsCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("az", [...input.args, "--only-show-errors", "--output", "json"], {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeAzureDevOpsCliError("execute", error),
    });

  const readBodyFile = (path: string) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) => normalizeAzureDevOpsCliError("readBodyFile", error),
    });

  return AzureDevOpsCli.of({
    execute,
    listPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          normalizeSourceBranch(input.headSelector),
          "--status",
          toAzureStatus(input.state),
          "--top",
          String(input.limit ?? 20),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeAzureDevOpsPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new AzureDevOpsCliError({
                        operation: "listPullRequests",
                        detail: `Azure DevOps CLI returned invalid PR list JSON: ${formatAzureDevOpsJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success);
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          normalizeChangeRequestId(input.reference),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeAzureDevOpsPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new AzureDevOpsCliError({
                    operation: "getPullRequest",
                    detail: `Azure DevOps CLI returned invalid pull request JSON: ${formatAzureDevOpsJsonDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(decoded.success);
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repos", "show", "--detect", "true", "--repository", input.repository],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(
            raw,
            RawAzureDevOpsRepositorySchema,
            "getRepositoryCloneUrls",
            "Azure DevOps CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      readBodyFile(input.bodyFile).pipe(
        Effect.flatMap((description) =>
          execute({
            cwd: input.cwd,
            args: [
              "repos",
              "pr",
              "create",
              "--detect",
              "true",
              "--target-branch",
              input.baseBranch,
              "--source-branch",
              normalizeSourceBranch(input.headSelector),
              "--title",
              input.title,
              "--description",
              description,
            ],
          }),
        ),
        Effect.asVoid,
      ),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repos", "show", "--detect", "true", "--repository", input.repository],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(
            raw,
            RawAzureDevOpsRepositorySchema,
            "getDefaultBranch",
            "Azure DevOps CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "checkout",
          "--id",
          normalizeChangeRequestId(input.reference),
          "--remote-name",
          "origin",
        ],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(AzureDevOpsCli, make);
