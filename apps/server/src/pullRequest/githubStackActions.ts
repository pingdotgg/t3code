import type { PullRequestAction, PullRequestMergeMethod } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
    expectedHeadSha?: string;
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
  if (
    stack?.number !== input.stackNumber ||
    top?.number !== input.number ||
    !input.expectedHeadSha ||
    top.headSha !== input.expectedHeadSha
  ) {
    return yield* fail("changed");
  }
  const open = stack.layers.filter((layer) => layer.state !== "merged");
  if (open.length === 0 || open.some((layer) => layer.state !== "open"))
    return yield* fail("unsupported");
  if (input.action === "update-branch") {
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
      `sha=${input.expectedHeadSha}`,
    ],
  });
  let result = yield* decode(request.stdout);
  for (let attempt = 0; result.status === "pending" && attempt < 120; attempt++) {
    const uuid = result.details.uuid;
    if (!uuid) return yield* fail("invalid-response");
    yield* Effect.sleep("1 second");
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
