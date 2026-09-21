import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { Octokit as RestOctokit } from "@octokit/rest";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

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
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: () =>
        octokit.paginate(octokit.rest.repos.listTeams, {
          owner,
          repo,
          per_page: 100,
        }),
      catch: (error) => error as Error,
    });
  });

const listTestOrgAccess = Effect.gen(function* () {
  const credentials = yield* yield* GitHubCredentials;
  const provider = yield* Provider.findProviderByType<GitHub.TeamAccess>(
    GitHub.TeamAccess.Type,
  );
  return yield* provider.list().pipe(
    Effect.provideService(
      GitHubCredentials,
      Effect.succeed({
        ...credentials,
        octokit: (override) => {
          const octokit = credentials.octokit(override);
          octokit.hook.before("request", (options) => {
            const url = new URL(options.url, "https://api.github.com");
            if (url.pathname === "/user/repos") {
              url.pathname = `/orgs/${owner}/repos`;
              options.url = url.href;
            }
            if (
              url.hostname !== "api.github.com" ||
              !(
                url.pathname === `/orgs/${owner}/repos` ||
                url.pathname.startsWith(`/repos/${owner}/`) ||
                (options.url === "/repos/{owner}/{repo}/teams" &&
                  options.owner === owner)
              )
            ) {
              throw new Error(
                `Refusing GitHub enumeration outside ${owner}: ${options.url}`,
              );
            }
          });
          return octokit;
        },
      }),
    ),
  );
});

test.provider(
  "grant, update, list, and revoke dedicated team access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const octokit = yield* Octokit;
      // Creating a fresh dedicated team requires admin:org; never use an existing team's access.
      const { data: team } = yield* Effect.tryPromise({
        try: () =>
          octokit.rest.teams.create({
            org: owner,
            name: teamName,
            privacy: "closed",
          }),
        catch: (error) => error as Error,
      });
      expect(team.slug).toBe(teamName);

      const deployAccess = (
        permission?: GitHub.TeamAccessProps["permission"],
      ) =>
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
              repository: Output.map(
                repo.fullName,
                (fullName) => fullName.split("/")[1]!,
              ),
              teamSlug: team.slug,
              permission,
            }).pipe(destroy());
          }),
        );

      yield* Effect.gen(function* () {
        const created = yield* deployAccess();
        expect(created).toEqual({ teamSlug: team.slug, permission: "push" });
        expect(
          (yield* getTeams(repositoryName)).find(
            (item) => item.slug === team.slug,
          )?.permission,
        ).toBe("push");
        expect(yield* listTestOrgAccess).toContainEqual({
          teamSlug: team.slug,
          permission: "push",
        });

        const updated = yield* deployAccess("admin");
        expect(updated.permission).toBe("admin");
        expect(
          (yield* getTeams(repositoryName)).find(
            (item) => item.slug === team.slug,
          )?.permission,
        ).toBe("admin");
      }).pipe(
        Effect.onExit(() =>
          Effect.gen(function* () {
            yield* stack.destroy();
            // Verify access removal while both the repository and team still exist.
            expect(
              (yield* getTeams(repositoryName)).find(
                (item) => item.slug === team.slug,
              ),
            ).toBeUndefined();
            yield* Effect.tryPromise({
              try: () =>
                octokit.rest.teams.deleteInOrg({
                  org: owner,
                  team_slug: team.slug,
                }),
              catch: (error) => error as Error,
            });
            const remaining = yield* Effect.tryPromise({
              try: () =>
                octokit.paginate(octokit.rest.teams.list, {
                  org: owner,
                  per_page: 100,
                }),
              catch: (error) => error as Error,
            });
            expect(remaining.some((item) => item.slug === team.slug)).toBe(
              false,
            );
          }).pipe(Effect.orDie),
        ),
      );
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider("list team access only within the authorized test org", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    expect(Array.isArray(yield* listTestOrgAccess)).toBe(true);
    yield* stack.destroy();
  }),
);

const grants = new Map<string, string>();
const requests: { method: string; path: string }[] = [];
let rejectWrites = false;
const mockedCredentials = Layer.succeed(
  GitHubCredentials,
  Effect.succeed({
    token: Redacted.make("test-token"),
    octokit: () =>
      new RestOctokit({
        auth: "test-token",
        request: {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            Effect.runPromise(
              Effect.sync(() => {
                const url = new URL(
                  typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url,
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
                    if (rejectWrites)
                      return json(
                        { message: "Resource not accessible by integration" },
                        403,
                      );
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
                  return json([
                    { owner: { login: owner }, name: repositoryName },
                  ]);
                }
                if (
                  method === "GET" &&
                  url.pathname === `/repos/${owner}/${repositoryName}/teams`
                ) {
                  return json(
                    [...grants].map(([key, permission]) => ({
                      slug: key.split("/")[0],
                      permission,
                    })),
                  );
                }
                throw new Error(
                  `Unexpected mocked request: ${method} ${url.pathname}`,
                );
              }),
            ),
        },
      }),
  }),
);
const { test: unit } = Test.make({
  providers: Layer.effect(
    GitHub.Providers,
    Provider.collection([GitHub.TeamAccess]),
  ).pipe(
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
      expect(yield* provider.list()).toEqual([
        { teamSlug: teamName, permission: "admin" },
      ]);

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
);

unit(
  "unit: rejects production and arbitrary fixture owners",
  Effect.sync(() => {
    expect(() => testOwner("alchemy-run")).toThrow("Unsafe GITHUB_TEST_OWNER");
    expect(() => testOwner("personal-account")).toThrow(
      "Unsafe GITHUB_TEST_OWNER",
    );
    expect(() => testOwner("")).toThrow("Unsafe GITHUB_TEST_OWNER");
    expect(testOwner("alchemy-run-test")).toBe("alchemy-run-test");
    expect(testOwner("alchemy-run-test-2")).toBe("alchemy-run-test-2");
  }),
);
