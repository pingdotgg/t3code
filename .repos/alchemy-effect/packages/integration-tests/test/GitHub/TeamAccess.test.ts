import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Repos from "@distilled.cloud/github/repos";
import * as Teams from "@distilled.cloud/github/teams";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { destroy } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { gh, mockGitHub, scopedToOwner } from "./scope.ts";

const testOwner = (value: string) => {
  if (value !== "alchemy-run-test" && value !== "alchemy-run-test-2") {
    throw new Error(`Unsafe GITHUB_TEST_OWNER: ${value}`);
  }
  return value;
};
const owner = testOwner(process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test");
testOwner(process.env.GITHUB_TEST_OWNER_2 ?? "alchemy-run-test-2");
const repositoryName = "alchemy-pr-1572-team-access";
const teamName = "alchemy-pr-1572-team-access";
const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const getTeams = (repo: string) =>
  Effect.gen(function* () {
    return yield* gh(
      Stream.runCollect(
        Repos.listTeams.items({
          owner,
          repo,
          per_page: 100,
        }),
      ),
    );
  });

const listTestOrgAccess = Effect.gen(function* () {
  const provider = yield* Provider.findProviderByType<GitHub.TeamAccess>(GitHub.TeamAccess.Type);
  return yield* provider.list().pipe(scopedToOwner(owner));
});

test.provider(
  "grant, update, list, and revoke dedicated team access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Creating a fresh dedicated team requires admin:org; never use an existing team's access.
      const team = yield* gh(
        Teams.create({
          org: owner,
          name: teamName,
          privacy: "closed",
        }),
      );
      expect(team.slug).toBe(teamName);

      const deployAccess = (permission?: GitHub.TeamAccessProps["permission"]) =>
        stack.deploy(
          Effect.gen(function* () {
            // Retained intentionally: the default gh token does not have delete_repo.
            const repo = yield* GitHub.Repository("Repo", {
              owner,
              name: repositoryName,
              visibility: "private",
              autoInit: true,
            });
            return yield* GitHub.TeamAccess("TeamAccess", {
              owner,
              repository: Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!),
              teamSlug: team.slug,
              permission,
            }).pipe(destroy());
          }),
        );

      yield* Effect.gen(function* () {
        const created = yield* deployAccess();
        expect(created).toEqual({ teamSlug: team.slug, permission: "push" });
        expect(
          (yield* getTeams(repositoryName)).find((item) => item.slug === team.slug)?.permission,
        ).toBe("push");
        expect(yield* listTestOrgAccess).toContainEqual({
          teamSlug: team.slug,
          permission: "push",
        });

        const updated = yield* deployAccess("admin");
        expect(updated.permission).toBe("admin");
        expect(
          (yield* getTeams(repositoryName)).find((item) => item.slug === team.slug)?.permission,
        ).toBe("admin");
      }).pipe(
        Effect.onExit(() =>
          Effect.gen(function* () {
            yield* stack.destroy();
            // Verify access removal while both the repository and team still exist.
            expect(
              (yield* getTeams(repositoryName)).find((item) => item.slug === team.slug),
            ).toBeUndefined();
            yield* gh(
              Teams.deleteInOrg({
                org: owner,
                team_slug: team.slug,
              }),
            );
            const remaining = yield* gh(
              Stream.runCollect(
                Teams.list.items({
                  org: owner,
                  per_page: 100,
                }),
              ),
            );
            expect(remaining.some((item) => item.slug === team.slug)).toBe(false);
          }).pipe(Effect.orDie),
        ),
      );
      yield* stack.destroy();
    }),
  {
    tags: ["provider:github", "provider:github:repository", "provider:github:teamaccess", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "list team access only within the authorized test org",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      expect(Array.isArray(yield* listTestOrgAccess)).toBe(true);
      yield* stack.destroy();
    }),
  { tags: ["provider:github", "provider:github:teamaccess", "live"] },
);

const grants = new Map<string, string>();
const requests: { method: string; path: string }[] = [];
let rejectWrites = false;
const mockedCredentials = mockGitHub((input: string | URL | Request, init?: RequestInit) =>
  Effect.runPromise(
    Effect.sync(() => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      const match = url.pathname.match(
        /^\/orgs\/([^/]+)\/teams\/([^/]+)\/repos\/([^/]+)\/([^/]+)$/,
      );
      if (match) {
        expect(match[1]).toBe(owner);
        expect(match[3]).toBe(owner);
        const key = `${match[2]}/${match[4]}`;
        if (method === "PUT") {
          if (rejectWrites) return json({ message: "Resource not accessible by integration" }, 403);
          grants.set(key, JSON.parse(String(init?.body)).permission);
          return new Response(null, { status: 204 });
        }
        if (method === "DELETE") {
          return grants.delete(key)
            ? new Response(null, { status: 204 })
            : json({ message: "Not Found" }, 404);
        }
      }
      if (method === "GET" && url.pathname === "/user/repos") {
        return json([{ owner: { login: owner }, name: repositoryName }]);
      }
      if (method === "GET" && url.pathname === `/repos/${owner}/${repositoryName}/teams`) {
        return json(
          [...grants].map(([key, permission]) => ({
            slug: key.split("/")[0],
            permission,
          })),
        );
      }
      throw new Error(`Unexpected mocked request: ${method} ${url.pathname}`);
    }),
  ),
);
const { test: unit } = Test.make({
  providers: Layer.effect(GitHub.Providers, Provider.collection([GitHub.TeamAccess])).pipe(
    Layer.provide(GitHub.TeamAccessProvider()),
    Layer.provideMerge(mockedCredentials),
  ),
});

unit.provider(
  "unit: defaults, updates, replacement, retention, errors, and idempotent deletion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (
        teamSlug: string,
        permission?: GitHub.TeamAccessProps["permission"],
        remove = true,
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const access = GitHub.TeamAccess("Access", {
              owner,
              repository: repositoryName,
              teamSlug,
              permission,
            });
            return yield* remove ? access.pipe(destroy()) : access;
          }),
        );

      expect((yield* deploy(teamName)).permission).toBe("push");
      expect(grants.get(`${teamName}/${repositoryName}`)).toBe("push");
      expect((yield* deploy(teamName, "admin")).permission).toBe("admin");
      expect(grants.get(`${teamName}/${repositoryName}`)).toBe("admin");
      const provider = yield* Provider.findProviderByType<GitHub.TeamAccess>(
        GitHub.TeamAccess.Type,
      );
      expect(yield* provider.list()).toEqual([{ teamSlug: teamName, permission: "admin" }]);

      const replacement = `${teamName}-replacement`;
      yield* deploy(replacement, "pull");
      expect(grants.has(`${teamName}/${repositoryName}`)).toBe(false);
      expect(grants.get(`${replacement}/${repositoryName}`)).toBe("pull");

      // An out-of-band revocation must not make stack deletion fail.
      yield* Effect.sync(() => grants.clear());
      yield* stack.destroy();
      expect(requests).toContainEqual({
        method: "DELETE",
        path: `/orgs/${owner}/teams/${replacement}/repos/${owner}/${repositoryName}`,
      });

      yield* deploy(teamName, "triage", false);
      yield* stack.destroy();
      expect(grants.get(`${teamName}/${repositoryName}`)).toBe("triage");
      yield* deploy(teamName, "maintain");
      yield* stack.destroy();
      expect(grants.size).toBe(0);

      yield* Effect.sync(() => {
        rejectWrites = true;
      });
      const rejected = yield* deploy(teamName).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      yield* Effect.sync(() => {
        rejectWrites = false;
      });
      yield* stack.destroy();
      expect(grants.size).toBe(0);
    }),
  { tags: ["unit", "provider:github", "provider:github:teamaccess", "local"] },
);

unit(
  "unit: rejects production and arbitrary fixture owners",
  Effect.sync(() => {
    expect(() => testOwner("alchemy-run")).toThrow("Unsafe GITHUB_TEST_OWNER");
    expect(() => testOwner("personal-account")).toThrow("Unsafe GITHUB_TEST_OWNER");
    expect(() => testOwner("")).toThrow("Unsafe GITHUB_TEST_OWNER");
    expect(testOwner("alchemy-run-test")).toBe("alchemy-run-test");
    expect(testOwner("alchemy-run-test-2")).toBe("alchemy-run-test-2");
  }),
  { tags: ["unit", "provider:github", "provider:github:teamaccess", "local"] },
);
