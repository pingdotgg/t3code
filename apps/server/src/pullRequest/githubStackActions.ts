import type {
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestStackHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { decodePullRequestStacksJson } from "./gitHubPullRequestJson.ts";

export class GitHubStackChangedError extends Schema.TaggedError<GitHubStackChangedError>()(
  "GitHubStackChangedError",
  { number: Schema.Int, completed: Schema.Int },
) {
  get detail(): string {
    return this.message;
  }

  override get message(): string {
    return this.completed > 0
      ? `The stack changed at PR #${this.number} after ${this.completed} layers. Earlier updates remain on GitHub. Refresh it before trying again.`
      : "The stack changed. Refresh it before trying again.";
  }
}

export class GitHubStackUnsupportedError extends Schema.TaggedError<GitHubStackUnsupportedError>()(
  "GitHubStackUnsupportedError",
  {},
) {
  get detail(): string {
    return this.message;
  }

  override get message(): string {
    return "This operation is not supported for this stack.";
  }
}

export class GitHubStackResponseInvalidError extends Schema.TaggedError<GitHubStackResponseInvalidError>()(
  "GitHubStackResponseInvalidError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  get detail(): string {
    return this.message;
  }

  override get message(): string {
    return "GitHub returned an unreadable stack operation response.";
  }
}

export class GitHubStackMergeRejectedError extends Schema.TaggedError<GitHubStackMergeRejectedError>()(
  "GitHubStackMergeRejectedError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  get detail(): string {
    return this.message;
  }

  override get message(): string {
    return "GitHub refused the stack merge. Check the stack's branch rules and merge requirements.";
  }
}

export class GitHubStackMergePendingError extends Schema.TaggedError<GitHubStackMergePendingError>()(
  "GitHubStackMergePendingError",
  {},
) {
  get detail(): string {
    return this.message;
  }

  override get message(): string {
    return "The merge is still running on GitHub. Check its status there before submitting another request.";
  }
}

export class GitHubStackPermissionError extends Schema.TaggedError<GitHubStackPermissionError>()(
  "GitHubStackPermissionError",
  {},
) {
  get detail(): string {
    return this.message;
  }

  override get message(): string {
    return "You cannot update every branch in this stack. Check write access and fork maintainer permissions before retrying.";
  }
}

export class GitHubStackRebaseFailedError extends Schema.TaggedError<GitHubStackRebaseFailedError>()(
  "GitHubStackRebaseFailedError",
  { number: Schema.Int, completed: Schema.Int, cause: Schema.Defect() },
) {
  get detail(): string {
    return this.message;
  }

  override get message(): string {
    return `Stack rebase stopped at PR #${this.number} after ${this.completed} layers. Earlier updates remain on GitHub; resolve the failing layer before retrying.`;
  }
}

export type GitHubStackActionError =
  | GitHubStackChangedError
  | GitHubStackUnsupportedError
  | GitHubStackResponseInvalidError
  | GitHubStackMergeRejectedError
  | GitHubStackMergePendingError
  | GitHubStackPermissionError
  | GitHubStackRebaseFailedError;

const MergeResponse = Schema.Struct({
  status: Schema.Literals(["pending", "merged", "enqueued", "failed"]),
  details: Schema.Struct({
    uuid: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
});

const decodeBranchAccess = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Record(
            Schema.String,
            Schema.NullOr(
              Schema.Struct({
                headRepository: Schema.NullOr(
                  Schema.Struct({ viewerPermission: Schema.NullOr(Schema.String) }),
                ),
                maintainerCanModify: Schema.Boolean,
              }),
            ),
          ),
        ),
      }),
    }),
  ),
);

const decodeRebaseBranch = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            id: Schema.String,
            headRefOid: Schema.String,
            baseRef: Schema.Struct({ compare: Schema.Struct({ behindBy: Schema.Int }) }),
          }),
        }),
      }),
    }),
  ),
);
const decodeRebaseResponse = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        updatePullRequestBranch: Schema.Struct({
          pullRequest: Schema.Struct({ headRefOid: Schema.String }),
        }),
      }),
    }),
  ),
);

const decodeMergeResponse = Schema.decodeEffect(Schema.fromJsonString(MergeResponse));

/** Remote-only updates: a stack rebase never switches or rewrites the environment's checkout. */
export const runGitHubStackAction = Effect.fn("runGitHubStackAction")(function* (input: {
  cwd: string;
  repository: string;
  host: string;
  number: number;
  stackNumber: number;
  expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
  action: PullRequestAction;
  mergeMethod?: PullRequestMergeMethod;
}) {
  const github = yield* GitHubCli.GitHubCli;
  if (input.action !== "merge" && input.action !== "update-branch")
    return yield* new GitHubStackUnsupportedError({});
  const endpoint = `repos/${input.repository}`;
  const read = yield* github.execute({
    cwd: input.cwd,
    args: ["api", "--hostname", input.host, `${endpoint}/stacks?pull_request=${input.number}`],
  });
  const decoded = decodePullRequestStacksJson(read.stdout);
  if (Result.isFailure(decoded))
    return yield* new GitHubStackResponseInvalidError({ cause: decoded.failure });
  const stack = decoded.success;
  const top = stack?.layers.at(-1);
  if (stack?.number !== input.stackNumber || top?.number !== input.number) {
    return yield* new GitHubStackChangedError({ number: input.number, completed: 0 });
  }
  const open = stack.layers.filter((layer) => layer.state !== "merged");
  if (
    !input.expectedStackHeads ||
    input.expectedStackHeads.length !== open.length ||
    new Set(input.expectedStackHeads.map((layer) => layer.number)).size !== open.length ||
    open.some(
      (layer) =>
        !layer.headSha ||
        !input.expectedStackHeads?.some(
          (expected) => expected.number === layer.number && expected.headSha === layer.headSha,
        ),
    )
  ) {
    return yield* new GitHubStackChangedError({ number: input.number, completed: 0 });
  }
  if (open.length === 0 || open.some((layer) => layer.state !== "open"))
    return yield* new GitHubStackUnsupportedError({});
  if (input.action === "update-branch") {
    const [owner, name] = input.repository.split("/");
    const permissions = yield* github.execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        "graphql",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${open
          .map(
            (layer) =>
              `pr${layer.number}:pullRequest(number:${layer.number}){headRepository{viewerPermission} maintainerCanModify}`,
          )
          .join(" ")}}}`,
      ],
    });
    const access = yield* decodeBranchAccess(permissions.stdout).pipe(
      Effect.mapError((cause) => new GitHubStackResponseInvalidError({ cause })),
    );
    // viewerCanUpdateBranch is false for an already-current layer, even if rebasing its parent
    // will make it stale. Check branch write access separately before touching any layer.
    if (
      open.some((layer) => {
        const pr = access.data.repository?.[`pr${layer.number}`];
        return (
          !pr?.headRepository ||
          (!pr.maintainerCanModify &&
            !["ADMIN", "MAINTAIN", "WRITE"].includes(pr.headRepository.viewerPermission ?? ""))
        );
      })
    )
      return yield* new GitHubStackPermissionError({});
    for (const [index, layer] of open.entries()) {
      yield* Effect.gen(function* () {
        const read = yield* github.execute({
          cwd: input.cwd,
          args: [
            "api",
            "--hostname",
            input.host,
            "graphql",
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${layer.number}`,
            "-f",
            `sha=${layer.headSha}`,
            "-f",
            "query=query($owner:String!,$name:String!,$number:Int!,$sha:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid baseRef{compare(headRef:$sha){behindBy}}}}}",
          ],
        });
        const {
          data: {
            repository: { pullRequest: pr },
          },
        } = yield* decodeRebaseBranch(read.stdout);
        if (pr.headRefOid !== layer.headSha)
          return yield* new GitHubStackChangedError({ number: layer.number, completed: index });
        if (pr.baseRef.compare.behindBy === 0) return;
        // Pass the reviewed revision to GitHub, including when a push races this read.
        const updated = yield* github.execute({
          cwd: input.cwd,
          args: [
            "api",
            "--hostname",
            input.host,
            "graphql",
            "-f",
            `id=${pr.id}`,
            "-f",
            `sha=${layer.headSha}`,
            "-f",
            "query=mutation($id:ID!,$sha:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$sha,updateMethod:REBASE}){pullRequest{headRefOid}}}",
          ],
        });
        yield* decodeRebaseResponse(updated.stdout);
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "GitHubStackChangedError"
            ? cause
            : new GitHubStackRebaseFailedError({
                number: layer.number,
                completed: index,
                cause,
              }),
        ),
      );
    }
    return;
  }
  if (open.some((layer) => layer.isDraft)) return yield* new GitHubStackUnsupportedError({});
  const decode = (raw: string) =>
    decodeMergeResponse(raw).pipe(
      Effect.mapError((cause) => new GitHubStackResponseInvalidError({ cause })),
    );
  const request = yield* github.execute({
    cwd: input.cwd,
    args: [
      "api",
      "--hostname",
      input.host,
      "--method",
      "PUT",
      `${endpoint}/pulls/${input.number}/merge-async`,
      "-f",
      `merge_method=${input.mergeMethod ?? "merge"}`,
      "-f",
      "merge_action=default",
      "-f",
      `sha=${top.headSha}`,
    ],
  });
  let result = yield* decode(request.stdout);
  const deadline = (yield* Clock.currentTimeMillis) + 5 * 60_000;
  for (
    let attempt = 0;
    result.status === "pending" && (yield* Clock.currentTimeMillis) < deadline;
    attempt++
  ) {
    const uuid = result.details.uuid;
    if (!uuid) return yield* new GitHubStackResponseInvalidError({});
    yield* Effect.sleep(Math.min(1_000 * 2 ** attempt, 10_000));
    const poll = yield* github.execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        `${endpoint}/pulls/${input.number}/merge-async/${encodeURIComponent(uuid)}`,
      ],
    });
    result = yield* decode(poll.stdout);
  }
  if (result.status === "pending") return yield* new GitHubStackMergePendingError({});
  if (result.status === "failed")
    return yield* new GitHubStackMergeRejectedError({ cause: result.details.message });
});
