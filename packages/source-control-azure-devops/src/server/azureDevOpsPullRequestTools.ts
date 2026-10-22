import { applyAzureDevOpsSuggestion } from "./azureDevOpsSuggestion.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestLabelCandidateList,
  PullRequestReviewerCandidateList,
  PullRequestHostAction,
  PullRequestHostActionResult,
  PullRequestHostDetails,
  PullRequestCheck,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type {
  AzureDevOpsItemContent,
  AzureDevOpsIteration,
  AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";
import type {
  AzureDevOpsPullRequestCliError,
  AzureDevOpsPullRequestReadError,
} from "./AzureDevOpsPullRequestCli.ts";

const BranchOperation = Schema.Struct({
  cherryPickId: Schema.optional(Schema.Int),
  revertId: Schema.optional(Schema.Int),
  status: Schema.String,
  detailedStatus: Schema.optional(Schema.Struct({ errorMessage: Schema.optional(Schema.String) })),
});
const Line = Schema.optional(Schema.NullOr(Schema.Struct({ line: Schema.Int })));
const SuggestionThread = Schema.Struct({
  comments: Schema.Array(Schema.Struct({ id: Schema.Int, content: Schema.String })),
  threadContext: Schema.NullOr(
    Schema.Struct({ filePath: Schema.String, rightFileStart: Line, rightFileEnd: Line }),
  ),
  pullRequestThreadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        iterationContext: Schema.optional(
          Schema.NullOr(Schema.Struct({ secondComparingIteration: Schema.Int })),
        ),
        trackingCriteria: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              origFilePath: Schema.optional(Schema.NullOr(Schema.String)),
              origRightFileStart: Line,
              origRightFileEnd: Line,
            }),
          ),
        ),
      }),
    ),
  ),
});
const Attachment = Schema.Struct({ displayName: Schema.String, url: Schema.String });
const Identity = Schema.Struct({
  id: Schema.String,
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  vote: Schema.optional(Schema.NullOr(Schema.Int)),
  isRequired: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isFlagged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hasDeclined: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isContainer: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const Label = Schema.Struct({ id: Schema.String, name: Schema.String });
const PullRequest = Schema.Struct({
  pullRequestId: Schema.Int,
  status: Schema.String,
  sourceRefName: Schema.optional(Schema.String),
  forkSource: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.Struct({
          id: Schema.String,
          webUrl: Schema.optional(Schema.String),
          project: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
        }),
      }),
    ),
  ),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  createdBy: Schema.optional(Identity),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(Identity))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Label))),
  repository: Schema.Struct({
    id: Schema.String,
    webUrl: Schema.String,
    project: Schema.Struct({ id: Schema.String }),
  }),
  lastMergeSourceCommit: Schema.optional(Schema.NullOr(Schema.Struct({ commitId: Schema.String }))),
  lastMergeCommit: Schema.optional(Schema.NullOr(Schema.Struct({ commitId: Schema.String }))),
});
const Status = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Int)),
  iterationId: Schema.optional(Schema.NullOr(Schema.Int)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.Struct({
    name: Schema.String,
    genre: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const Policy = Schema.Struct({
  evaluationId: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  configuration: Schema.Struct({
    id: Schema.Int,
    isBlocking: Schema.optional(Schema.NullOr(Schema.Boolean)),
    type: Schema.Struct({ displayName: Schema.String, id: Schema.optional(Schema.String) }),
    settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
const WorkItem = Schema.Struct({
  id: Schema.Int,
  fields: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const Subscription = Schema.Struct({
  id: Schema.String,
  filter: Schema.Struct({ type: Schema.String, artifactId: Schema.optional(Schema.String) }),
});
const Favorite = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  repositoryId: Schema.String,
});
const Ref = Schema.Struct({ name: Schema.String });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decoders = {
  pullRequest: decodeJsonResult(PullRequest),
  reviewers: decodeJsonResult(Schema.Struct({ value: Schema.Array(Identity) })),
  branchOperation: decodeJsonResult(BranchOperation),
  suggestionThread: decodeJsonResult(SuggestionThread),
  push: decodeJsonResult(
    Schema.Struct({ commits: Schema.Array(Schema.Struct({ commitId: Schema.String })) }),
  ),
  subscriptions: decodeJsonResult(Schema.Struct({ value: Schema.Array(Subscription) })),
  favorites: decodeJsonResult(Schema.Struct({ value: Schema.Array(Favorite) })),
  labels: decodeJsonResult(Schema.Struct({ value: Schema.Array(Label) })),
  policies: decodeJsonResult(Schema.Array(Policy)),
  attachment: decodeJsonResult(Attachment),
  user: decodeJsonResult(Schema.Struct({ id: Schema.String })),
  attachments: decodeJsonResult(Schema.Struct({ value: Schema.Array(Attachment) })),
  statuses: decodeJsonResult(Schema.Struct({ value: Schema.Array(Status) })),
  workItems: decodeJsonResult(Schema.Array(WorkItem)),
  branches: decodeJsonResult(Schema.Array(Ref)),
  users: decodeJsonResult(
    Schema.Struct({
      totalCount: Schema.Int,
      items: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          user: Schema.Struct({
            displayName: Schema.String,
            mailAddress: Schema.String,
          }),
        }),
      ),
    }),
  ),
  resolvedIdentities: decodeJsonResult(
    Schema.Struct({
      value: Schema.Array(Schema.Struct({ id: Schema.String, descriptor: Schema.String })),
    }),
  ),
  groups: decodeJsonResult(
    Schema.Struct({
      continuationToken: Schema.optional(Schema.NullOr(Schema.String)),
      graphGroups: Schema.Array(
        Schema.Struct({
          descriptor: Schema.String,
          displayName: Schema.String,
          principalName: Schema.String,
        }),
      ),
    }),
  ),
};
type Target = { cwd: string; location: AzureDevOpsRepositoryLocation; number: number };
type Write = (input: {
  cwd: string;
  resource: string;
  area?: string;
  routeParameters: ReadonlyArray<string>;
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  body?: string;
}) => Effect.Effect<void, AzureDevOpsPullRequestCliError>;

const MERGE_TYPE_POLICY = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";
const MERGE_TYPE_SETTINGS = {
  noFastForward: "allowNoFastForward",
  squash: "allowSquash",
  rebase: "allowRebase",
  rebaseMerge: "allowRebaseMerge",
} as const;

/** The completion strategies every blocking merge-type policy on the target branch allows. */
function allowedMergeStrategies(policies: ReadonlyArray<Schema.Schema.Type<typeof Policy>>) {
  return (["noFastForward", "squash", "rebase", "rebaseMerge"] as const).filter((strategy) =>
    policies.every((check) => {
      if (!check.configuration.isBlocking || check.configuration.type.id !== MERGE_TYPE_POLICY)
        return true;
      const settings = check.configuration.settings;
      if (!settings) return true;
      // Any `allow*` key means the policy has moved off the legacy `useSquashMerge`.
      if (
        typeof settings.useSquashMerge === "boolean" &&
        !Object.values(MERGE_TYPE_SETTINGS).some((key) => typeof settings[key] === "boolean")
      )
        return settings.useSquashMerge ? strategy === "squash" : strategy === "noFastForward";
      return settings[MERGE_TYPE_SETTINGS[strategy]] === true;
    }),
  );
}

/** Lines `start` through `end` of a file, or null where the file has fewer. */
function lineRange(content: string, start: number, end: number) {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return start < 1 || end < start || end > lines.length ? null : lines.slice(start - 1, end);
}

function currentStatuses(
  statuses: ReadonlyArray<Schema.Schema.Type<typeof Status>>,
  iterationId: number | null,
) {
  const latest = new Map<string, Schema.Schema.Type<typeof Status>>();
  for (const status of statuses) {
    if (status.iterationId != null && iterationId !== null && status.iterationId !== iterationId)
      continue;
    const key = JSON.stringify([status.context.genre ?? "", status.context.name]);
    const previous = latest.get(key);
    // Azure appends a new status for each update; collection order is not guaranteed.
    if (!previous || (status.id ?? 0) >= (previous.id ?? 0)) latest.set(key, status);
  }
  return [...latest.values()].map((status) =>
    status.iterationId != null && iterationId === null
      ? {
          ...status,
          state: "pending",
          description: "The current PR update could not be read; this status is unverified.",
        }
      : status,
  );
}

export function makeAzureDevOpsPullRequestTools(deps: {
  listIterations: (
    input: Target,
  ) => Effect.Effect<ReadonlyArray<AzureDevOpsIteration>, AzureDevOpsPullRequestCliError>;
  readItemContent: (input: {
    cwd: string;
    location: AzureDevOpsRepositoryLocation;
    path: string;
    commit: string;
  }) => Effect.Effect<AzureDevOpsItemContent, AzureDevOpsPullRequestCliError>;
  resolveIdentities: (input: {
    cwd: string;
    descriptors: ReadonlyArray<string>;
  }) => Effect.Effect<{ stdout: string }, AzureDevOpsPullRequestCliError>;
  uploadAttachment: (
    input: Target & { fileName: string; data: string },
  ) => Effect.Effect<{ stdout: string }, AzureDevOpsPullRequestCliError>;
  subscriptions: (input: {
    cwd: string;
    viewerId: string;
  }) => Effect.Effect<{ stdout: string }, AzureDevOpsPullRequestCliError>;
  identity: (input: {
    cwd: string;
  }) => Effect.Effect<{ id: string; login: string; name: string }, AzureDevOpsPullRequestCliError>;
  execute: (input: {
    cwd: string;
    args: ReadonlyArray<string>;
    maxOutputBytes?: number;
  }) => Effect.Effect<{ stdout: string }, AzureDevOpsPullRequestCliError>;
  write: Write;
  writeJson: (input: Parameters<Write>[0]) => Effect.Effect<string, AzureDevOpsPullRequestCliError>;
  failure: (input: {
    cwd: string;
    command: "az";
    operation: string;
    reason?: AzureDevOpsPullRequestReadError["reason"];
    cause: unknown;
  }) => AzureDevOpsPullRequestCliError;
}) {
  const read = <A>(
    target: Target,
    args: ReadonlyArray<string>,
    decode: (value: string) => Result.Result<A, unknown>,
  ) =>
    deps.execute({ cwd: target.cwd, args, maxOutputBytes: 4 * 1024 * 1024 }).pipe(
      Effect.flatMap((result) => {
        const parsed = decode(result.stdout.trim() || "[]");
        return Result.isSuccess(parsed)
          ? Effect.succeed(parsed.success)
          : Effect.fail(
              deps.failure({
                cwd: target.cwd,
                command: "az",
                operation: "pull request tools",
                cause: parsed.failure,
              }),
            );
      }),
    );
  const show = (target: Target) =>
    Effect.all(
      [
        read(
          target,
          ["repos", "pr", "show", "--detect", "true", "--id", String(target.number)],
          decoders.pullRequest,
        ),
        read(
          target,
          [
            "devops",
            "invoke",
            "--detect",
            "true",
            "--area",
            "git",
            "--resource",
            "pullRequestReviewers",
            "--api-version",
            "7.1",
            "--route-parameters",
            `project=${target.location.project}`,
            `repositoryId=${target.location.repository}`,
            `pullRequestId=${target.number}`,
          ],
          decoders.reviewers,
        ),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map(([pr, reviewers]) => ({ ...pr, reviewers: reviewers.value })));
  const route = (target: Target) => [
    `project=${target.location.project}`,
    `repositoryId=${target.location.repository}`,
    `pullRequestId=${target.number}`,
  ];
  const patch = (target: Target, body: unknown) =>
    deps.write({
      cwd: target.cwd,
      resource: "pullRequests",
      routeParameters: route(target),
      method: "PATCH",
      body: encodeJson(body),
    });
  const policies = (target: Target) =>
    read(
      target,
      ["repos", "pr", "policy", "list", "--detect", "true", "--id", String(target.number)],
      decoders.policies,
    );
  const mergeStrategies = (target: Target) =>
    policies(target).pipe(Effect.map(allowedMergeStrategies));
  const checks = (
    target: Target & { iterationId: number | null },
  ): Effect.Effect<
    {
      checks: ReadonlyArray<PullRequestCheck>;
      allowedMergeStrategies: NonNullable<PullRequestHostDetails["allowedMergeStrategies"]>;
    },
    AzureDevOpsPullRequestCliError
  > =>
    Effect.all(
      [
        policies(target),
        read(
          target,
          [
            "devops",
            "invoke",
            "--detect",
            "true",
            "--area",
            "git",
            "--resource",
            "pullRequestStatuses",
            "--api-version",
            "7.1",
            "--route-parameters",
            ...route(target),
          ],
          decoders.statuses,
        ),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([items, statuses]) => ({
        allowedMergeStrategies: allowedMergeStrategies(items),
        checks: [
          ...items.map((item) => ({
            name: item.configuration.type.displayName,
            required: item.configuration.isBlocking === true,
            description: `Branch policy: ${item.status ?? "unknown"}${item.status === "queued" && (item.context?.isExpired === true || item.context?.buildIsNotCurrent === true) ? " (previous build expired; awaiting a new evaluation)" : ""}`,
            url: null,
            status:
              item.status === "approved"
                ? ("success" as const)
                : item.status === "rejected" || item.status === "broken"
                  ? ("failure" as const)
                  : item.status === "notApplicable"
                    ? ("skipped" as const)
                    : ("pending" as const),
          })),
          ...currentStatuses(statuses.value, target.iterationId).map((status) => ({
            name: [status.context.genre, status.context.name].filter(Boolean).join(" / "),
            description: status.description ?? null,
            url: status.targetUrl ?? null,
            status:
              status.state === "succeeded"
                ? ("success" as const)
                : status.state === "failed" || status.state === "error"
                  ? ("failure" as const)
                  : status.state === "notApplicable"
                    ? ("skipped" as const)
                    : ("pending" as const),
          })),
        ],
      })),
    );
  const subscription = (
    target: Target,
    pr: Schema.Schema.Type<typeof PullRequest>,
    viewerId: string,
  ) =>
    deps.subscriptions({ cwd: target.cwd, viewerId }).pipe(
      Effect.flatMap((output) => {
        const parsed = decoders.subscriptions(output.stdout);
        return Result.isSuccess(parsed)
          ? Effect.succeed(
              parsed.success.value.find(
                (item) =>
                  item.filter.type.toLowerCase() === "artifact" &&
                  item.filter.artifactId?.toLowerCase() ===
                    `${pr.repository.project.id}%2f${pr.repository.id}%2f${target.number}`.toLowerCase(),
              ),
            )
          : Effect.fail(
              deps.failure({
                cwd: target.cwd,
                command: "az",
                operation: "notification subscriptions",
                cause: parsed.failure,
              }),
            );
      }),
    );
  const favorite = (target: Target, pr: Schema.Schema.Type<typeof PullRequest>) =>
    read(
      target,
      [
        "devops",
        "invoke",
        "--detect",
        "true",
        "--area",
        "git",
        "--resource",
        "refsFavorites",
        "--api-version",
        "7.1",
        "--route-parameters",
        `project=${target.location.project}`,
        "--query-parameters",
        `repositoryId=${pr.repository.id}`,
      ],
      decoders.favorites,
    ).pipe(
      Effect.map((page) =>
        page.value.find(
          (item) =>
            item.name === pr.sourceRefName &&
            item.repositoryId.toLowerCase() === pr.repository.id.toLowerCase(),
        ),
      ),
    );
  const attachments = (target: Target) =>
    read(
      target,
      [
        "devops",
        "invoke",
        "--detect",
        "true",
        "--area",
        "git",
        "--resource",
        "pullRequestAttachments",
        "--api-version",
        "7.1",
        "--route-parameters",
        ...route(target),
      ],
      decoders.attachments,
    ).pipe(Effect.map((page) => page.value));
  const details = Effect.fn("AzureDevOpsPullRequestTools.details")(function* (target: Target) {
    const [pr, viewer] = yield* Effect.all([show(target), deps.identity(target)], {
      concurrency: 2,
    });
    const warnings: string[] = [];
    const deniedActions: Record<string, string> = {};
    const partial = <A>(
      operation: Effect.Effect<A, AzureDevOpsPullRequestCliError>,
      label: string,
      fallback: A,
      actions: readonly string[] = [],
    ) =>
      operation.pipe(
        Effect.orElseSucceed((error) => {
          warnings.push(label);
          if (
            error._tag === "AzureDevOpsCliAuthenticationError" ||
            /\b(?:401|403)\b|access denied|not authorized|requires user authentication|TF401027/i.test(
              error.detail,
            )
          )
            for (const action of actions)
              deniedActions[action] =
                "Your token does not allow this action. Update its access and refresh the PR.";
          return fallback;
        }),
      );
    const [checks, workItems, branches, following, sourceBranchFavorite, files] = yield* Effect.all(
      [
        partial(policies(target), "Policies could not be read.", []),
        partial(
          read(
            target,
            ["repos", "pr", "work-item", "list", "--detect", "true", "--id", String(target.number)],
            decoders.workItems,
          ),
          "Linked work items could not be read.",
          [],
          ["work-items"],
        ),
        partial(
          read(
            target,
            [
              "repos",
              "ref",
              "list",
              "--detect",
              "true",
              "--project",
              target.location.project,
              "--repository",
              target.location.repository,
              "--filter",
              "heads/",
            ],
            decoders.branches,
          ),
          "Branches could not be read.",
          [],
        ),
        partial(
          subscription(target, pr, viewer.id).pipe(Effect.map((value) => value !== undefined)),
          "Notification subscriptions could not be read.",
          null,
          ["follow"],
        ),
        partial(
          favorite(target, pr).pipe(Effect.map((value) => value !== undefined)),
          "Branch favorites could not be read.",
          null,
          ["favorite-source"],
        ),
        partial(attachments(target), "Attachments could not be read.", []),
      ],
      { concurrency: 3 },
    );
    const stringField = (item: Schema.Schema.Type<typeof WorkItem>, field: string) =>
      typeof item.fields?.[field] === "string" ? String(item.fields[field]) : "";
    return {
      provider: "azure-devops",
      deniedActions,
      allowedMergeStrategies: allowedMergeStrategies(checks),
      viewerId: viewer.id,
      canDeclineReview:
        pr.status === "active" &&
        viewer.id !== pr.createdBy?.id &&
        ((pr.reviewers ?? []).find((person) => person.id === viewer.id)?.hasDeclined === true ||
          !(pr.reviewers ?? []).some(
            (person) => person.id === viewer.id && (person.isRequired || person.vote),
          )),
      canFlagReview: pr.status === "active" && viewer.id !== pr.createdBy?.id,
      following,
      sourceBranchFavorite,
      reviewers: (pr.reviewers ?? []).map((reviewer) => ({
        id: reviewer.id,
        login: reviewer.uniqueName ?? "",
        name: reviewer.displayName ?? reviewer.uniqueName ?? reviewer.id,
        required: reviewer.isRequired === true,
        vote: reviewer.vote ?? 0,
        group: reviewer.isContainer === true,
        flagged: reviewer.isFlagged === true,
        declined: reviewer.hasDeclined === true,
      })),
      policies: checks.map((check) => ({
        id: check.evaluationId,
        configurationId: check.configuration.id,
        name: check.configuration.type.displayName,
        status: check.status ?? "unknown",
        required: check.configuration.isBlocking === true,
        url: `${pr.repository.webUrl.split("/_git/")[0]}/_settings/repositories?repo=${encodeURIComponent(pr.repository.id)}&_a=policiesMid`,
      })),
      workItems: workItems.map((item) => ({
        id: item.id,
        title: stringField(item, "System.Title") || `Work item #${item.id}`,
        state: stringField(item, "System.State"),
        url: `${new URL(pr.repository.webUrl).origin}${new URL(pr.repository.webUrl).pathname.split("/_git/")[0]}/_workitems/edit/${item.id}`,
      })),
      attachments: files.map((file) => ({ name: file.displayName, url: file.url })),
      branches: branches.map((branch) => branch.name.replace(/^refs\/heads\//, "")),
      mergePreviewUrl: pr.lastMergeCommit
        ? `${pr.repository.webUrl}/commit/${pr.lastMergeCommit.commitId}`
        : null,
      warnings,
    } satisfies PullRequestHostDetails;
  });
  const run = Effect.fn("AzureDevOpsPullRequestTools.run")(function* (
    input: Target & { action: PullRequestHostAction },
  ): Effect.fn.Return<PullRequestHostActionResult, AzureDevOpsPullRequestCliError> {
    const { action } = input;
    const pr = yield* show(input);
    const requireActive = () =>
      pr.status === "active"
        ? Effect.void
        : Effect.fail(
            deps.failure({
              command: "az",
              cwd: input.cwd,
              operation: action.type,
              reason: "inactive",
              cause: "This pull request is no longer active.",
            }),
          );
    const branchRef = (name: string) =>
      name.startsWith("refs/heads/") ? name : `refs/heads/${name}`;
    if (
      [
        "vote",
        "retarget",
        "complete",
        "reviewer-required",
        "restart-merge",
        "apply-suggestion",
      ].includes(action.type)
    )
      yield* requireActive();
    switch (action.type) {
      case "attachment-upload": {
        const output = yield* deps.uploadAttachment({
          ...input,
          fileName: action.fileName,
          data: action.data,
        });
        const attachment = decoders.attachment(output.stdout);
        if (Result.isFailure(attachment))
          return yield* deps.failure({
            cwd: input.cwd,
            command: "az",
            operation: action.type,
            cause: attachment.failure,
          });
        return {
          message: "Attachment uploaded. Copy its Markdown link into your comment.",
          url: attachment.success.url,
        };
      }
      case "attachment-delete":
        yield* deps.write({
          cwd: input.cwd,
          resource: "pullRequestAttachments",
          // `az devops invoke` splices route values into the URL as given, so a `#`, `?` or `%`
          // in the name would address a different attachment.
          routeParameters: [...route(input), `fileName=${encodeURIComponent(action.fileName)}`],
          method: "DELETE",
        });
        break;
      case "share": {
        const receivers = yield* Effect.forEach(
          action.receivers,
          (receiver) =>
            /^[0-9a-f-]{36}$/i.test(receiver)
              ? Effect.succeed({ id: receiver })
              : read(
                  input,
                  ["devops", "user", "show", "--detect", "true", "--user", receiver],
                  decoders.user,
                ),
          { concurrency: 3 },
        );
        yield* deps.write({
          cwd: input.cwd,
          resource: "pullRequestShare",
          routeParameters: route(input),
          method: "POST",
          body: encodeJson({ message: action.message, receivers }),
        });
        return { message: "Pull request shared.", url: null };
      }
      case "apply-suggestion": {
        const sourceRepository = pr.forkSource?.repository.id ?? input.location.repository;
        const sourceProject = pr.forkSource?.repository.project?.id ?? input.location.project;
        const sourceLocation = { project: sourceProject, repository: sourceRepository };
        const sourceWebUrl = pr.forkSource
          ? (pr.forkSource.repository.webUrl ??
            `${pr.repository.webUrl.split("/_git/")[0]!.replace(/\/[^/]+$/, "")}/${encodeURIComponent(sourceProject)}/_git/${encodeURIComponent(sourceRepository)}`)
          : pr.repository.webUrl;
        const refuse = (reason: NonNullable<AzureDevOpsPullRequestReadError["reason"]>) =>
          Effect.fail(
            deps.failure({
              cwd: input.cwd,
              command: "az",
              operation: action.type,
              reason,
              cause: reason,
            }),
          );
        const ids = /^([1-9]\d*):([1-9]\d*)$/.exec(action.commentId);
        const iterations = yield* deps.listIterations(input);
        const latest = iterations.at(-1);
        // Positions are tracked to the latest push, so that push has to be the head being edited.
        if (
          !ids ||
          !pr.sourceRefName ||
          !latest ||
          pr.lastMergeSourceCommit?.commitId !== action.expectedHead ||
          latest.headCommit !== action.expectedHead
        )
          return yield* refuse("stale-suggestion");
        // Without `$iteration` Azure answers with the lines of the push the comment was left on.
        const thread = yield* read(
          input,
          [
            "devops",
            "invoke",
            "--detect",
            "true",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            "--api-version",
            "7.1",
            "--route-parameters",
            ...route(input),
            `threadId=${ids[1]}`,
            "--query-parameters",
            `$iteration=${latest.id}`,
            "$baseIteration=0",
          ],
          decoders.suggestionThread,
        );
        const comment = thread.comments.find((comment) => comment.id === Number(ids[2]));
        const context = thread.threadContext;
        const startLine = context?.rightFileStart?.line;
        if (!comment || !context || startLine === undefined)
          return yield* refuse("invalid-suggestion-anchor");
        const endLine = context.rightFileEnd?.line ?? startLine;
        const tracking = thread.pullRequestThreadContext?.trackingCriteria;
        const originalId =
          thread.pullRequestThreadContext?.iterationContext?.secondComparingIteration ??
          (iterations.length === 1 ? latest.id : undefined);
        const original = iterations.find((iteration) => iteration.id === originalId);
        if (startLine < 1 || !original) return yield* refuse("outdated-suggestion");
        const [item, before] = yield* Effect.all(
          [
            deps.readItemContent({
              cwd: input.cwd,
              location: sourceLocation,
              path: context.filePath,
              commit: action.expectedHead,
            }),
            original.id === latest.id
              ? Effect.succeed(null)
              : deps.readItemContent({
                  cwd: input.cwd,
                  location: sourceLocation,
                  path: tracking?.origFilePath ?? context.filePath,
                  commit: original.headCommit,
                }),
          ],
          { concurrency: 2 },
        );
        if (item.isBinary || before?.isBinary) return yield* refuse("binary-suggestion");
        // Azure omits tracking for both an untouched anchor and a deleted one, and may track a
        // range whose text was since rewritten. Only the text the reviewer saw may be replaced.
        if (before) {
          const originalStart = tracking?.origRightFileStart?.line ?? startLine;
          const originalEnd =
            tracking?.origRightFileEnd?.line ?? originalStart + endLine - startLine;
          const seen = lineRange(before.contents, originalStart, originalEnd);
          const current = lineRange(item.contents, startLine, endLine);
          if (!seen || !current || seen.join("\n") !== current.join("\n"))
            return yield* refuse("changed-suggestion");
        }
        const content = yield* Effect.try({
          try: () =>
            applyAzureDevOpsSuggestion({
              body: comment.content,
              content: item.contents,
              startLine,
              endLine,
            }),
          catch: (cause) =>
            deps.failure({
              cwd: input.cwd,
              command: "az",
              operation: action.type,
              reason: "invalid-suggestion",
              cause,
            }),
        });
        if (content === item.contents)
          return yield* deps.failure({
            cwd: input.cwd,
            command: "az",
            operation: action.type,
            reason: "already-applied-suggestion",
            cause: "This suggestion is already present in the source file.",
          });
        const output = yield* deps.writeJson({
          cwd: input.cwd,
          resource: "pushes",
          routeParameters: [`project=${sourceProject}`, `repositoryId=${sourceRepository}`],
          method: "POST",
          body: encodeJson({
            refUpdates: [{ name: pr.sourceRefName, oldObjectId: action.expectedHead }],
            commits: [
              {
                comment: `Apply suggestion from PR #${input.number}`,
                changes: [
                  {
                    changeType: "edit",
                    item: { path: context.filePath },
                    newContent: { content, contentType: "rawtext" },
                  },
                ],
              },
            ],
          }),
        });
        const pushed = decoders.push(output);
        const commitId = Result.isSuccess(pushed) ? pushed.success.commits[0]?.commitId : undefined;
        const resolved = yield* deps
          .write({
            cwd: input.cwd,
            resource: "pullRequestThreads",
            routeParameters: [...route(input), `threadId=${ids[1]}`],
            method: "PATCH",
            body: encodeJson({ status: "fixed" }),
          })
          .pipe(Effect.result);
        return {
          message: Result.isFailure(resolved)
            ? "Suggestion committed, but its discussion could not be resolved. Use the status control to retry."
            : "Suggestion committed and discussion resolved.",
          url: commitId
            ? `${sourceWebUrl}/commit/${commitId}`
            : `${pr.repository.webUrl}/pullrequest/${input.number}`,
        };
      }
      case "follow": {
        const viewer = yield* deps.identity(input);
        const current = yield* subscription(input, pr, viewer.id);
        if (action.enabled && !current)
          yield* deps.write({
            cwd: input.cwd,
            area: "notification",
            resource: "Subscriptions",
            routeParameters: [],
            method: "POST",
            body: encodeJson({
              filter: {
                artifactId: `${pr.repository.project.id}%2f${pr.repository.id}%2f${input.number}`,
                artifactType: "PullRequestId",
                eventType: null,
                type: "Artifact",
              },
            }),
          });
        if (!action.enabled && current)
          yield* deps.write({
            cwd: input.cwd,
            area: "notification",
            resource: "Subscriptions",
            routeParameters: [`subscriptionId=${current.id}`],
            method: "DELETE",
          });
        break;
      }
      case "favorite-source": {
        const current = yield* favorite(input, pr);
        if (action.enabled && !current)
          yield* deps.write({
            cwd: input.cwd,
            resource: "refsFavorites",
            routeParameters: [`project=${input.location.project}`],
            method: "POST",
            body: encodeJson({ name: pr.sourceRefName, repositoryId: pr.repository.id, type: 2 }),
          });
        if (!action.enabled && current)
          yield* deps.write({
            cwd: input.cwd,
            resource: "refsFavorites",
            routeParameters: [`project=${input.location.project}`, `favoriteId=${current.id}`],
            method: "DELETE",
          });
        break;
      }
      case "reviewer-flag":
      case "decline-review": {
        const viewer = yield* deps.identity(input);
        const reviewerId = action.type === "decline-review" ? viewer.id : action.reviewerId;
        const reviewer = pr.reviewers?.find((person) => person.id === viewer.id);
        if (
          pr.status !== "active" ||
          viewer.id === pr.createdBy?.id ||
          reviewerId !== viewer.id ||
          (action.type === "decline-review" &&
            action.declined &&
            (reviewer?.isRequired || reviewer?.vote))
        )
          return yield* deps.failure({
            cwd: input.cwd,
            command: "az",
            operation: action.type,
            reason: "reviewer-ineligible",
            cause:
              "Only an optional reviewer with no vote can decline. Authors cannot decline or flag their own review.",
          });
        if (!pr.reviewers?.some((reviewer) => reviewer.id === reviewerId))
          yield* deps.write({
            cwd: input.cwd,
            resource: "pullRequestReviewers",
            routeParameters: [...route(input), `reviewerId=${reviewerId}`],
            method: "PUT",
            body: encodeJson({ id: reviewerId, vote: 0 }),
          });
        yield* deps.write({
          cwd: input.cwd,
          resource: "pullRequestReviewers",
          routeParameters: [...route(input), `reviewerId=${reviewerId}`],
          method: "PATCH",
          body: encodeJson(
            action.type === "decline-review"
              ? { hasDeclined: action.declined }
              : { isFlagged: action.flagged },
          ),
        });
        break;
      }
      case "vote":
        if (pr.isDraft)
          return yield* deps.failure({
            command: "az",
            cwd: input.cwd,
            operation: "vote",
            reason: "draft-vote",
            cause: "Publish this draft before voting.",
          });
        {
          const viewer = yield* deps.identity(input);
          yield* deps.write({
            cwd: input.cwd,
            resource: "pullRequestReviewers",
            routeParameters: [...route(input), `reviewerId=${viewer.id}`],
            method: "PUT",
            body: encodeJson({
              id: viewer.id,
              vote: {
                approve: 10,
                "approve-with-suggestions": 5,
                "wait-for-author": -5,
                reject: -10,
                reset: 0,
              }[action.vote],
              isReapprove: true,
            }),
          });
        }
        break;
      case "retarget":
        yield* patch(input, { targetRefName: branchRef(action.branch) });
        break;
      case "reviewer-required":
        yield* deps.write({
          cwd: input.cwd,
          resource: "pullRequestReviewers",
          routeParameters: [...route(input), `reviewerId=${encodeURIComponent(action.reviewerId)}`],
          method: "PUT",
          body: encodeJson({
            id: action.reviewerId,
            isRequired: action.required,
            vote:
              (yield* deps.identity(input)).id === action.reviewerId
                ? (pr.reviewers?.find((reviewer) => reviewer.id === action.reviewerId)?.vote ?? 0)
                : 0,
          }),
        });
        break;
      case "work-items":
        yield* deps.execute({
          cwd: input.cwd,
          args: [
            "repos",
            "pr",
            "work-item",
            action.linked ? "add" : "remove",
            "--detect",
            "true",
            "--id",
            String(input.number),
            "--work-items",
            ...action.ids.map(String),
          ],
        });
        break;
      case "requeue-policy":
        yield* deps.write({
          cwd: input.cwd,
          area: "policy",
          resource: "evaluations",
          routeParameters: [
            `project=${input.location.project}`,
            `evaluationId=${encodeURIComponent(action.evaluationId)}`,
          ],
          method: "PATCH",
        });
        break;
      case "restart-merge":
        yield* patch(input, { mergeStatus: 1 });
        return {
          message: "Azure checked the merge preview and queued an update if needed.",
          url: null,
        };
      case "complete": {
        if (pr.isDraft)
          return yield* deps.failure({
            command: "az",
            cwd: input.cwd,
            operation: "complete",
            reason: "draft-completion",
            cause: "Publish this draft before completing it.",
          });
        const checks = yield* policies(input);
        const completionOptions = {
          mergeStrategy: action.strategy,
          deleteSourceBranch: action.deleteSourceBranch,
          transitionWorkItems: action.transitionWorkItems,
          mergeCommitMessage: action.message,
          bypassPolicy: action.bypassPolicy,
          bypassReason: action.bypassReason,
          autoCompleteIgnoreConfigIds: action.waitForOptionalPolicies
            ? []
            : checks
                .filter((check) => !check.configuration.isBlocking)
                .map((check) => check.configuration.id),
        };
        if (action.automatic) {
          // One update arms auto-complete with its options, so neither can land without the other.
          const viewer = yield* deps.identity(input);
          yield* patch(input, { autoCompleteSetBy: { id: viewer.id }, completionOptions });
        } else {
          yield* patch(input, {
            status: "completed",
            lastMergeSourceCommit: pr.lastMergeSourceCommit,
            completionOptions,
          });
        }
        break;
      }
      case "revert":
      case "cherry-pick":
        if (action.type === "revert" && pr.status !== "completed")
          return yield* deps.failure({
            command: "az",
            cwd: input.cwd,
            operation: "revert",
            reason: "not-completed",
            cause: "Only a completed pull request can be reverted.",
          });
        const created = yield* deps.writeJson({
          cwd: input.cwd,
          resource: action.type === "revert" ? "reverts" : "cherryPicks",
          routeParameters: [
            `project=${input.location.project}`,
            `repositoryId=${input.location.repository}`,
          ],
          method: "POST",
          body: encodeJson({
            generatedRefName: branchRef(action.newBranch),
            ontoRefName: branchRef(action.targetBranch),
            source: { pullRequestId: input.number },
          }),
        });
        const parsed = decoders.branchOperation(created);
        if (Result.isFailure(parsed))
          return yield* deps.failure({
            cwd: input.cwd,
            command: "az",
            operation: action.type,
            cause: parsed.failure,
          });
        let operation = parsed.success;
        const operationId = operation.cherryPickId ?? operation.revertId;
        for (let attempt = 0; operation.status !== "completed" && attempt < 60; attempt++) {
          if (operation.status !== "queued" && operation.status !== "inProgress")
            return yield* deps.failure({
              cwd: input.cwd,
              command: "az",
              operation: action.type,
              reason: "branch-operation-failed",
              cause:
                operation.detailedStatus?.errorMessage ?? `Azure reported ${operation.status}.`,
            });
          if (operationId === undefined)
            return yield* deps.failure({
              cwd: input.cwd,
              command: "az",
              operation: action.type,
              reason: "branch-operation-id-missing",
              cause: "Azure omitted the branch operation id.",
            });
          yield* Effect.sleep("500 millis");
          operation = yield* read(
            input,
            [
              "devops",
              "invoke",
              "--detect",
              "true",
              "--area",
              "git",
              "--resource",
              action.type === "revert" ? "reverts" : "cherryPicks",
              "--api-version",
              "7.1",
              "--route-parameters",
              `project=${input.location.project}`,
              `repositoryId=${input.location.repository}`,
              `${action.type === "revert" ? "revertId" : "cherryPickId"}=${operationId}`,
            ],
            decoders.branchOperation,
          );
        }
        if (operation.status !== "completed")
          return {
            message:
              "Azure is still processing the branch operation. Check its result on the host before continuing.",
            url: `${pr.repository.webUrl}/pullrequest/${input.number}`,
          };
        if (action.createPullRequest) {
          const createdPr = yield* read(
            input,
            [
              "repos",
              "pr",
              "create",
              "--detect",
              "true",
              "--project",
              input.location.project,
              "--repository",
              input.location.repository,
              `--source-branch=${action.newBranch.replace(/^refs\/heads\//, "")}`,
              `--target-branch=${action.targetBranch.replace(/^refs\/heads\//, "")}`,
              "--title",
              `${action.type === "revert" ? "Revert" : "Cherry-pick"} PR #${input.number}`,
              "--description",
              `${action.type === "revert" ? "Reverts" : "Cherry-picks"} pull request #${input.number}.`,
            ],
            decoders.pullRequest,
          ).pipe(Effect.result);
          return Result.isSuccess(createdPr)
            ? {
                message: "Follow-up pull request created.",
                url: `${pr.repository.webUrl}/pullrequest/${createdPr.success.pullRequestId}`,
              }
            : {
                message:
                  "Branch created, but its follow-up pull request could not be created. Open the branch to create the pull request without repeating this operation.",
                url: `${pr.repository.webUrl}?version=GB${encodeURIComponent(action.newBranch.replace(/^refs\/heads\//, ""))}`,
              };
        }
        return {
          message: "Branch created.",
          url: `${pr.repository.webUrl}?version=GB${encodeURIComponent(action.newBranch.replace(/^refs\/heads\//, ""))}`,
        };
    }
    return { message: "Pull request updated.", url: null };
  });
  const labels = (input: Target) =>
    read(
      input,
      [
        "devops",
        "invoke",
        "--detect",
        "true",
        "--area",
        "git",
        "--resource",
        "pullRequestLabels",
        "--api-version",
        "7.1",
        "--route-parameters",
        ...route(input),
      ],
      decoders.labels,
    ).pipe(Effect.map((page) => page.value));
  const labelCandidates = (input: Target) =>
    labels(input).pipe(
      Effect.map(
        (items) =>
          ({
            candidates: items.map((label) => ({
              name: label.name,
              color: null,
              description: null,
              isApplied: true,
            })),
            truncated: false,
          }) satisfies PullRequestLabelCandidateList,
      ),
    );
  const setLabels = Effect.fn("AzureDevOpsPullRequestTools.setLabels")(function* (
    input: Target & { labels: ReadonlyArray<string>; applied: boolean },
  ) {
    const currentLabels = yield* labels(input);
    for (const name of input.labels) {
      const current = currentLabels.find((label) => label.name === name);
      if (input.applied && !current)
        yield* deps.write({
          cwd: input.cwd,
          resource: "pullRequestLabels",
          routeParameters: route(input),
          method: "POST",
          body: encodeJson({ name }),
        });
      if (!input.applied && current)
        yield* deps.write({
          cwd: input.cwd,
          resource: "pullRequestLabels",
          routeParameters: [...route(input), `labelIdOrName=${current.id}`],
          method: "DELETE",
        });
    }
  });
  const reviewerCandidates = Effect.fn("AzureDevOpsPullRequestTools.reviewerCandidates")(function* (
    input: Target,
  ) {
    // The directory reads need organization-level access a code-scoped token often lacks, so
    // either failing leaves the current reviewers and whatever was readable, marked incomplete.
    const [pr, users, groups] = yield* Effect.all(
      [
        show(input),
        read(
          input,
          ["devops", "user", "list", "--detect", "true", "--top", "1000"],
          decoders.users,
        ).pipe(Effect.orElseSucceed(() => null)),
        read(
          input,
          [
            "devops",
            "security",
            "group",
            "list",
            "--detect",
            "true",
            "--scope",
            "project",
            "--project",
            input.location.project,
          ],
          decoders.groups,
        ).pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: 3 },
    );
    const descriptors = groups?.graphGroups.map((group) => group.descriptor) ?? [];
    const resolved =
      descriptors.length === 0
        ? { value: [] }
        : yield* deps.resolveIdentities({ cwd: input.cwd, descriptors }).pipe(
            Effect.map((output) => decoders.resolvedIdentities(output.stdout)),
            Effect.map((decoded) => (Result.isSuccess(decoded) ? decoded.success : null)),
            Effect.orElseSucceed(() => null),
          );
    const groupIds = new Map(
      (resolved?.value ?? []).map((identity) => [identity.descriptor, identity.id]),
    );
    const requested = new Set(pr.reviewers?.map((person) => person.id));
    const candidates = [
      ...(users?.items ?? []).map(({ id, user }) => ({
        id,
        login: user.mailAddress || user.displayName,
        name: user.displayName,
        avatarUrl: null,
        kind: "user" as const,
        isRequested: requested.has(id),
      })),
      ...(groups?.graphGroups ?? []).flatMap((group) => {
        const id = groupIds.get(group.descriptor);
        return id
          ? [
              {
                id,
                login: group.principalName,
                name: group.displayName,
                avatarUrl: null,
                kind: "team" as const,
                isRequested: requested.has(id),
              },
            ]
          : [];
      }),
      ...(pr.reviewers ?? []).map((person) => ({
        id: person.id,
        login: person.uniqueName || person.displayName || person.id,
        name: person.displayName ?? null,
        avatarUrl: null,
        kind: person.isContainer ? ("team" as const) : ("user" as const),
        isRequested: true,
      })),
    ].filter((person) => person.id !== pr.createdBy?.id);
    return {
      candidates: [...new Map(candidates.map((person) => [person.id, person])).values()],
      truncated:
        !users ||
        !groups ||
        !resolved ||
        users.totalCount > users.items.length ||
        !!groups.continuationToken,
    } satisfies PullRequestReviewerCandidateList;
  });
  return {
    details,
    run,
    labelCandidates,
    setLabels,
    checks,
    mergeStrategies,
    reviewerCandidates,
  };
}
