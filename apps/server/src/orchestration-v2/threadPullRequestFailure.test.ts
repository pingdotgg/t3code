import { describe, expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { logThreadPullRequestFailure } from "./threadPullRequestFailure.ts";

const RETRY_AT = Date.parse("2026-08-01T01:00:00.000Z");
const github = SourceControlProviderKind.make("github");
const paused = new SourceControlRateLimitPausedError({
  provider: github,
  host: "github.com",
  retryAt: RETRY_AT,
});
const providerError = (fields: {
  reason: "rate-limited" | "failed";
  retryAt?: number;
  cause?: unknown;
}) =>
  new PullRequestProviderError({
    provider: github,
    operation: "getChangeRequestSummary",
    detail: "refused",
    ...fields,
  });

const logged = (cause: Cause.Cause<unknown>) => {
  const logs: Array<{ level: string; message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message });
  });
  return logThreadPullRequestFailure("lookup failed", cause, { threadIds: ["a", "b"] }).pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.as(logs),
  );
};

describe("logThreadPullRequestFailure", () => {
  it.effect.each([
    {
      name: "a host pause wrapped in a generic error",
      cause: Cause.fail(new Error("wrapper", { cause: paused })),
      line: "lookup failed: rate limited until 2026-08-01T01:00:00.000Z (threads: a, b)",
    },
    {
      // GitLab and Azure DevOps refuse without a reset time.
      name: "a refusal without a reset time",
      cause: Cause.fail(providerError({ reason: "rate-limited" })),
      line: "lookup failed: rate limited (threads: a, b)",
    },
    {
      name: "a reset time found deeper in the chain",
      cause: Cause.fail(providerError({ reason: "rate-limited", cause: paused })),
      line: "lookup failed: rate limited until 2026-08-01T01:00:00.000Z (threads: a, b)",
    },
    {
      name: "a garbled reset time",
      cause: Cause.fail(providerError({ reason: "rate-limited", retryAt: Number.NaN })),
      line: "lookup failed: rate limited (threads: a, b)",
    },
  ])("logs $name as one Info line", ({ cause, line }) =>
    Effect.gen(function* () {
      expect(yield* logged(cause)).toEqual([{ level: "Info", message: [line] }]);
    }),
  );

  it.effect.each([
    { name: "an unexpected failure", cause: Cause.fail(providerError({ reason: "failed" })) },
    {
      name: "a refusal beside a second failure",
      cause: Cause.combine(Cause.fail(paused), Cause.fail(new Error("unexpected"))),
    },
    { name: "a defect", cause: Cause.die(paused) },
  ])("keeps the Warn stack for $name", ({ cause }) =>
    Effect.gen(function* () {
      expect(yield* logged(cause)).toMatchObject([
        {
          level: "Warn",
          message: ["lookup failed", { threadIds: ["a", "b"], cause: expect.any(String) }],
        },
      ]);
    }),
  );
});
