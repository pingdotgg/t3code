import type {
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestStackHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { decodePullRequestStacksJson } from "./gitHubPullRequestJson.ts";

export class GitHubStackActionError extends Schema.TaggedError<GitHubStackActionError>()(
  "GitHubStackActionError",
  {
    number: Schema.Int,
    reason: Schema.Literals([
      "changed",
      "unsupported",
      "invalid-response",
      "rejected",
      "pending",
      "rebase-failed",
      "permission",
    ]),
    completed: Schema.Int,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get detail(): string {
    switch (this.reason) {
      case "changed":
        return "The stack changed. Refresh it before trying again.";
      case "unsupported":
        return "This operation is not supported for this stack.";
      case "invalid-response":
        return "GitHub returned an unreadable stack operation response.";
      case "rejected":
        return "GitHub refused the stack merge. Check the stack's branch rules and merge requirements.";
      case "pending":
        return "The merge is still running on GitHub. Check its status there before submitting another request.";
      case "permission":
        return "You cannot update every branch in this stack. Check write access and fork maintainer permissions before retrying.";
      case "rebase-failed":
        return `Stack rebase stopped at PR #${this.number} after ${this.completed} layers. Earlier updates remain on GitHub; resolve the failing layer before retrying.`;
    }
  }
  override get message(): string {
    return this.detail;
  }
}

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

const decodeMergeResponse = Schema.decodeEffect(Schema.fromJsonString(MergeResponse));

/** Remote-only updates: a stack rebase never switches or rewrites the environment's checkout. */
export const runGitHubStackAction = Effect.fn("runGitHubStackAction")(function* (
  execute: GitHubCli.GitHubCli["Service"]["execute"],
  input: {
    cwd: string;
    repository: string;
    host: string;
    number: number;
    stackNumber: number;
    expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
    action: PullRequestAction;
    mergeMethod?: PullRequestMergeMethod;
  },
) {
  const fail = (reason: GitHubStackActionError["reason"], cause?: unknown) =>
    new GitHubStackActionError({
      number: input.number,
      reason,
      completed: 0,
      ...(cause === undefined ? {} : { cause }),
    });
  if (input.action !== "merge" && input.action !== "update-branch")
    return yield* fail("unsupported");
  const endpoint = `repos/${input.repository}`;
  const read = yield* execute({
    cwd: input.cwd,
    args: ["api", "--hostname", input.host, `${endpoint}/stacks?pull_request=${input.number}`],
  });
  const decoded = decodePullRequestStacksJson(read.stdout);
  if (Result.isFailure(decoded)) return yield* fail("invalid-response", decoded.failure);
  const stack = decoded.success;
  const top = stack?.layers.at(-1);
  if (stack?.number !== input.stackNumber || top?.number !== input.number) {
    return yield* fail("changed");
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
    return yield* fail("changed");
  }
  if (open.length === 0 || open.some((layer) => layer.state !== "open"))
    return yield* fail("unsupported");
  if (input.action === "update-branch") {
    const [owner, name] = input.repository.split("/");
    const permissions = yield* execute({
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
      Effect.mapError((cause) => fail("invalid-response", cause)),
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
      return yield* fail("permission");
    for (const [index, layer] of open.entries()) {
      yield* execute({
        cwd: input.cwd,
        args: [
          "pr",
          "update-branch",
          String(layer.number),
          "--repo",
          `${input.host}/${input.repository}`,
          "--rebase",
        ],
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubStackActionError({
              number: layer.number,
              completed: index,
              reason: "rebase-failed",
              cause,
            }),
        ),
      );
    }
    return;
  }
  if (open.some((layer) => layer.isDraft)) return yield* fail("unsupported");
  const decode = (raw: string) =>
    decodeMergeResponse(raw).pipe(Effect.mapError((cause) => fail("invalid-response", cause)));
  const request = yield* execute({
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
    if (!uuid) return yield* fail("invalid-response");
    yield* Effect.sleep(Math.min(1_000 * 2 ** attempt, 10_000));
    const poll = yield* execute({
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
  if (result.status === "pending") return yield* fail("pending");
  if (result.status === "failed") return yield* fail("rejected", result.details.message);
});
