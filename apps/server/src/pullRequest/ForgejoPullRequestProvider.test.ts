import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ForgejoCli, ForgejoCliError, type ForgejoApiInput } from "../sourceControl/ForgejoCli.ts";
import { make } from "./ForgejoPullRequestProvider.ts";

const reference = { cwd: "/w", repository: "acme/web", host: "forge.example", number: 7 };
const reviewer = { login: "reviewer", full_name: "Reviewer" };
const team = { id: 2, name: "ReviewTeam", units: ["repo.code", "repo.pulls"] };
const pull = {
  number: 7,
  title: "Review me",
  body: "",
  html_url: "https://forge.example/acme/web/pulls/7",
  user: { login: "author" },
  state: "open",
  merged: false,
  head: { ref: "feature", sha: "abc", repo: { full_name: "acme/web" } },
  base: { ref: "main", sha: "def", repo: { full_name: "acme/web" } },
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
  closed_at: null,
  merged_at: null,
  labels: [],
  requested_reviewers: [reviewer],
  requested_reviewers_teams: [team],
};

const response = (body: unknown, headers = "") => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: JSON.stringify(body),
  stderr: `HTTP/1.1 200 OK\r\n${headers}`,
  stdoutTruncated: false,
  stderrTruncated: false,
});

function fakeApi({
  users = [pull.user, reviewer],
  teams = [] as readonly unknown[],
  headers = "",
  teamStatus,
}: {
  users?: readonly unknown[];
  teams?: readonly unknown[];
  headers?: string;
  teamStatus?: number;
} = {}) {
  const calls: ForgejoApiInput[] = [];
  const provider = make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli)({
        api: (input) => {
          calls.push(input);
          const path = input.path.split("?")[0];
          if (input.method === "POST" || input.method === "DELETE")
            return Effect.succeed(response(null));
          if (path === "repos/acme/web/pulls/7") return Effect.succeed(response(pull));
          if (path === "repos/acme/web/pulls") return Effect.succeed(response([pull]));
          // Forgejo 12.0.4 returns the complete assignee/team list, ignores page/limit,
          // and omits Link. Page 2 and page 999 repeat page 1 rather than returning [].
          if (path === "repos/acme/web/assignees") return Effect.succeed(response(users, headers));
          if (path === "repos/acme/web/teams")
            return teamStatus === undefined
              ? Effect.succeed(response(teams, headers))
              : Effect.fail(
                  new ForgejoCliError({
                    command: "tea",
                    cwd: input.cwd,
                    detail: "Team endpoint unavailable",
                    httpStatus: teamStatus,
                  }),
                );
          if (path === "repos/acme/web") return Effect.succeed(response({ full_name: "acme/web" }));
          if (path === "user") return Effect.succeed(response(reviewer));
          if (path?.startsWith("repos/acme/web/statuses/")) return Effect.succeed(response([]));
          return Effect.die(`Unexpected Forgejo path: ${input.path}`);
        },
      }),
    ),
  );
  return { provider, calls };
}

describe("Forgejo reviewer candidates", () => {
  for (const headers of ["", 'Link: <https://forge.example/api/v1/unused?page=2>; rel="next"']) {
    it.effect(
      `reads the unpaginated assignees once (${headers ? "misleading Link" : "no Link"})`,
      () =>
        Effect.gen(function* () {
          const fake = fakeApi({ headers });
          const provider = yield* fake.provider;
          const list = yield* provider.listReviewerCandidates(reference);
          expect(list.candidates.map(({ login }) => login)).toEqual(["reviewer"]);
          expect(list.truncated).toBe(false);
          expect(fake.calls.filter(({ path }) => path.includes("/assignees"))).toHaveLength(1);
          expect(fake.calls.every(({ path }) => !path.includes("page="))).toBe(true);
        }),
    );
  }

  it.effect("deduplicates identities, excludes the author, and preserves user/team requests", () =>
    Effect.gen(function* () {
      const fake = fakeApi({
        users: [
          pull.user,
          { login: "AUTHOR" },
          reviewer,
          { login: "REVIEWER" },
          { login: "ReviewTeam" },
        ],
        teams: [team, team, { id: 3, name: "CodeOnly", units: ["repo.code"] }],
      });
      const provider = yield* fake.provider;
      const list = yield* provider.listReviewerCandidates(reference);
      expect(
        list.candidates.map(({ id, kind, isRequested }) => ({ id, kind, isRequested })),
      ).toEqual([
        { id: "reviewer", kind: "user", isRequested: true },
        { id: "ReviewTeam", kind: "user", isRequested: false },
        { id: "ReviewTeam", kind: "team", isRequested: true },
      ]);
      expect(list.truncated).toBe(false);
      expect(fake.calls).toHaveLength(3);
    }),
  );

  it.effect("bounds unique eligible candidates and reports actual truncation", () =>
    Effect.gen(function* () {
      const users = [pull.user, ...Array.from({ length: 501 }, (_, i) => ({ login: `user-${i}` }))];
      const provider = yield* fakeApi({ users }).provider;
      const list = yield* provider.listReviewerCandidates(reference);
      expect(list.candidates).toHaveLength(500);
      expect(list.candidates[499]?.login).toBe("user-499");
      expect(list.truncated).toBe(true);
      const complete = yield* fakeApi({ users: users.slice(0, 501) }).provider;
      expect((yield* complete.listReviewerCandidates(reference)).truncated).toBe(false);
    }),
  );

  for (const teamStatus of [404, 405]) {
    it.effect(`keeps user candidates when teams are unsupported (HTTP ${teamStatus})`, () =>
      Effect.gen(function* () {
        const provider = yield* fakeApi({ teamStatus }).provider;
        const list = yield* provider.listReviewerCandidates(reference);
        expect(list.candidates.map(({ login }) => login)).toEqual(["reviewer"]);
        expect(list.truncated).toBe(false);
      }),
    );
  }

  it.effect("does not hide a team permission failure", () =>
    Effect.gen(function* () {
      const provider = yield* fakeApi({ teamStatus: 403 }).provider;
      const error = yield* provider.listReviewerCandidates(reference).pipe(Effect.flip);
      expect(error.operation).toBe("repos/acme/web/teams");
    }),
  );

  it.effect("sends team names separately on both request and removal", () =>
    Effect.gen(function* () {
      const fake = fakeApi();
      const provider = yield* fake.provider;
      for (const requested of [true, false])
        yield* provider.setReviewerRequest({
          ...reference,
          reviewers: [
            { kind: "user", id: "reviewer" },
            { kind: "team", id: "ReviewTeam" },
          ],
          requested,
        });
      expect(fake.calls.map(({ method, body }) => ({ method, body }))).toEqual([
        { method: "POST", body: { reviewers: ["reviewer"], team_reviewers: ["ReviewTeam"] } },
        { method: "DELETE", body: { reviewers: ["reviewer"], team_reviewers: ["ReviewTeam"] } },
      ]);
    }),
  );

  it.effect("keeps requested teams in detail without treating them as requested users", () =>
    Effect.gen(function* () {
      const provider = yield* fakeApi().provider;
      expect(
        (yield* provider.getChangeRequest(reference)).reviewers.map(({ login }) => login),
      ).toEqual(["reviewer", "ReviewTeam"]);
      const list = yield* provider.listChangeRequests({
        ...reference,
        state: "open",
        involvement: "all",
        viewer: team.name,
        limit: 1,
      });
      expect(list.items[0]?.reviewRequestLogins).toEqual(["reviewer"]);
    }),
  );
});
