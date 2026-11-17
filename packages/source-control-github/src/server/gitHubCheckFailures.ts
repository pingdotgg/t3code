import {
  NonNegativeInt,
  PositiveInt,
  type PullRequestCheck,
  type PullRequestCheckFailure,
  type PullRequestCheckStatus,
} from "@t3tools/contracts";
import { CheckLogExcerpt } from "@t3tools/source-control-core/server/pullRequestChecks";
import type { ProviderRepositoryRef } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HttpClientResponse } from "effect/http";
import * as GitHubRest from "./GitHubRest.ts";
import { GitHubApiResponseError, gitHubApiUrls } from "./GitHubRequestPolicy.ts";

const Job = Schema.Struct({
  id: PositiveInt,
  run_id: PositiveInt,
  run_attempt: PositiveInt,
  url: Schema.String,
  run_url: Schema.String,
  check_run_url: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  steps: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, conclusion: Schema.NullOr(Schema.String) })),
  ),
});
const Annotations = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    // 0 marks a file-level annotation.
    start_line: NonNegativeInt,
    annotation_level: Schema.Literals(["failure", "warning", "notice"]),
    message: Schema.String,
  }),
);

const JOB_CONCLUSIONS: Readonly<Record<string, PullRequestCheckStatus>> = {
  success: "success",
  failure: "failure",
  timed_out: "failure",
  startup_failure: "failure",
  action_required: "action-required",
  cancelled: "cancelled",
  skipped: "skipped",
  neutral: "neutral",
};

const decodeJob = Schema.decodeEffect(Schema.fromJsonString(Job));
const decodeAnnotations = Schema.decodeEffect(Schema.fromJsonString(Annotations));

export const makeGitHubCheckFailureReader = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return Effect.fn("GitHubCheckFailures.read")(function* (
    input: ProviderRepositoryRef & { readonly check: PullRequestCheck },
  ) {
    const base = {
      check: input.check.name,
      status: input.check.status,
      url: input.check.url,
      ...(input.check.required === undefined ? {} : { required: input.check.required }),
      failedSteps: [] as string[],
      annotations: [] as PullRequestCheckFailure["annotations"],
    };
    const unavailable = (
      reason: Extract<PullRequestCheckFailure["log"], { _tag: "unavailable" }>["reason"],
    ): PullRequestCheckFailure => ({ ...base, log: { _tag: "unavailable", reason } });
    // The handle's attempt is the run's latest; job ids are unique per attempt, so it is not checked.
    const handle = /^github-check:([1-9]\d*):\d+$/.exec(input.check.handle ?? "");
    if (handle === null) return unavailable("not-actions");
    const id = handle[1]!;
    const root = `repos/${input.repository}`;
    const context = { host: input.host, operation: "checkFailure", allowReserve: false };
    const jobResponse = yield* api
      .rest({ ...context, path: `${root}/actions/jobs/${id}`, maxResponseBytes: 256 * 1024 })
      .pipe(
        Effect.catchTags({
          GitHubApiNotFoundError: () => Effect.succeed("not-actions" as const),
          GitHubApiResponseError: (error) =>
            error.status === 403 ? Effect.succeed("no-access" as const) : Effect.fail(error),
        }),
      );
    if (typeof jobResponse === "string") return unavailable(jobResponse);
    const job = yield* decodeJob(jobResponse.body).pipe(
      Effect.mapError(() => new GitHubApiResponseError({ ...context, status: jobResponse.status })),
    );
    const apiRoot = `${gitHubApiUrls(input.host).rest}/${root}`.toLowerCase();
    if (
      String(job.id) !== id ||
      job.check_run_url.toLowerCase() !== `${apiRoot}/check-runs/${id}` ||
      job.url.toLowerCase() !== `${apiRoot}/actions/jobs/${id}` ||
      job.run_url.toLowerCase() !== `${apiRoot}/actions/runs/${job.run_id}`
    ) {
      return unavailable("not-actions");
    }
    if (job.status !== "completed")
      return {
        ...unavailable("still-running"),
        status: "pending" as const,
        attempt: job.run_attempt,
      };
    const annotationsResponse = yield* api
      .rest({
        ...context,
        path: `${root}/check-runs/${id}/annotations?per_page=20`,
        maxResponseBytes: 256 * 1024,
      })
      .pipe(
        Effect.catchTags({
          GitHubApiNotFoundError: () => Effect.succeed(null),
          GitHubApiResponseError: (error) =>
            error.status === 403 ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
    const annotations =
      annotationsResponse === null
        ? []
        : yield* decodeAnnotations(annotationsResponse.body).pipe(
            Effect.mapError(
              () => new GitHubApiResponseError({ ...context, status: annotationsResponse.status }),
            ),
          );
    const failedSteps = (job.steps ?? [])
      .filter((step) => step.conclusion === "failure")
      .map((step) => step.name);
    const log = yield* api
      .rest({
        ...context,
        path: `${root}/actions/jobs/${id}/logs`,
        followRedirect: "unauthenticated",
        readBody: Effect.fn("GitHubCheckFailures.readLog")(function* (
          response: HttpClientResponse.HttpClientResponse,
        ) {
          const excerpt = new CheckLogExcerpt();
          const decoder = new TextDecoder();
          yield* Stream.runForEach(response.stream, (chunk) =>
            Effect.sync(() => excerpt.write(decoder.decode(chunk, { stream: true }))),
          );
          excerpt.write(decoder.decode());
          return { ...excerpt.finish(), invalidUtf8: false };
        }),
      })
      .pipe(
        Effect.map((response): PullRequestCheckFailure["log"] => ({
          _tag: "excerpt",
          text: response.body,
          truncated: response.truncated,
          totalLines: response.totalLines ?? 0,
        })),
        Effect.catchTags({
          GitHubApiNotFoundError: () =>
            Effect.succeed({ _tag: "unavailable", reason: "expired" } as const),
          GitHubApiResponseError: (error) =>
            error.status === 404 || error.status === 410
              ? Effect.succeed({ _tag: "unavailable", reason: "expired" } as const)
              : error.status === 403
                ? Effect.succeed({ _tag: "unavailable", reason: "no-access" } as const)
                : Effect.fail(error),
        }),
      );
    return {
      ...base,
      status: JOB_CONCLUSIONS[job.conclusion ?? ""] ?? "neutral",
      attempt: job.run_attempt,
      failedSteps: failedSteps.slice(0, 20).map((name) => name.slice(0, 300)),
      annotations: annotations
        .filter(
          // Only drop exit 1 when the delivered excerpt already contains it.
          (annotation) =>
            annotation.message !== "Process completed with exit code 1." ||
            log._tag !== "excerpt" ||
            !log.text.includes(annotation.message),
        )
        .slice(0, 20)
        .map((annotation) => ({
          path: annotation.path.slice(0, 1024),
          startLine: annotation.start_line,
          level: annotation.annotation_level,
          message: annotation.message.slice(0, 300),
        })),
      log,
    } satisfies PullRequestCheckFailure;
  });
});
