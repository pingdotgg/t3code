import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { Octokit as OctokitClient } from "@octokit/rest";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const requireTestOwner = (owner: string) => {
  if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
    throw new Error(`Refusing GitHub collaborator tests for owner ${owner}`);
  }
  return owner;
};

const owner = requireTestOwner(
  process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test",
);
const fixtureNames = [
  "alchemy-pr-1571-collaborator-lifecycle",
  "alchemy-pr-1571-collaborator-replacement",
  "alchemy-pr-1571-collaborator-list",
];

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const verifiedMember = Effect.gen(function* () {
  const client = yield* Octokit;
  const requested = process.env.GITHUB_TEST_COLLABORATOR_USERNAME;
  if (!requested) {
    const members = yield* Effect.tryPromise({
      try: () =>
        client.paginate(client.rest.orgs.listMembers, {
          org: owner,
          role: "member",
          per_page: 100,
        }),
      catch: (error) => error as Error,
    });
    return yield* Effect.fail(
      new Error(
        `Set GITHUB_TEST_COLLABORATOR_USERNAME to an explicitly authorized active non-owner member of ${owner}; eligible members: ${members.map((member) => member.login).join(", ") || "none"}. No invitations or owner access changes are permitted.`,
      ),
    );
  }
  const { data: membership } = yield* Effect.tryPromise({
    try: () =>
      client.rest.orgs.getMembershipForUser({
        org: owner,
        username: requested,
      }),
    catch: (error) => error as Error,
  });
  if (membership.state !== "active" || membership.role !== "member") {
    return yield* Effect.fail(
      new Error(
        `Refusing collaborator ${requested}: ${owner} membership is ${membership.state}/${membership.role}; an authorized active non-owner member is required.`,
      ),
    );
  }
  return requested;
});

const repository = (index: number) =>
  GitHub.Repository(`Repo${index}`, {
    owner,
    name: fixtureNames[index]!,
    description:
      "PR 1571 collaborator test fixture; retained because the test token lacks delete_repo",
    visibility: "private",
    autoInit: true,
  });

const directCollaborators = (repo: string) =>
  Effect.gen(function* () {
    const client = yield* Octokit;
    return yield* Effect.tryPromise({
      try: () =>
        client.paginate(client.rest.repos.listCollaborators, {
          owner,
          repo,
          affiliation: "direct",
          per_page: 100,
        }),
      catch: (error) => error as Error,
    });
  });

const assertRemoved = (repo: string, username: string) =>
  Effect.gen(function* () {
    const remaining = yield* directCollaborators(repo).pipe(
      Effect.repeat({
        until: (collaborators) =>
          !collaborators.some(
            (collaborator) => collaborator.login === username,
          ),
        schedule: Schedule.spaced("1 second"),
        times: 8,
      }),
    );
    expect(
      remaining.some((collaborator) => collaborator.login === username),
    ).toBe(false);
    const client = yield* Octokit;
    const invitations = yield* Effect.tryPromise({
      try: () =>
        client.paginate(client.rest.repos.listInvitations, {
          owner,
          repo,
          per_page: 100,
        }),
      catch: (error) => error as Error,
    });
    expect(
      invitations.some((invitation) => invitation.invitee?.login === username),
    ).toBe(false);
  });

test.provider(
  "add, update, replace, and remove an authorized collaborator",
  (stack) =>
    Effect.gen(function* () {
      // Verify authorization before even replaying persisted deletes.
      const username = yield* verifiedMember;
      yield* stack.destroy();
      const deploy = (
        index: number,
        permission?: GitHub.CollaboratorProps["permission"],
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            // Keep both dependencies present while replacing the collaborator.
            const first = yield* repository(0);
            const second = yield* repository(1);
            return yield* GitHub.Collaborator("Collab", {
              owner,
              repository: Output.map(
                (index === 0 ? first : second).fullName,
                (fullName) => fullName.split("/")[1]!,
              ),
              username,
              permission,
            }).pipe(destroy());
          }),
        );
      const created = yield* deploy(0);
      expect(created.username).toBe(username);
      expect(created.permission).toBe("push");
      expect(
        (yield* directCollaborators(fixtureNames[0]!)).find(
          (member) => member.login === username,
        )?.permissions?.push,
      ).toBe(true);

      const updated = yield* deploy(0, "admin");
      expect(updated.permission).toBe("admin");
      expect(
        (yield* directCollaborators(fixtureNames[0]!)).find(
          (member) => member.login === username,
        )?.permissions?.admin,
      ).toBe(true);

      const replaced = yield* deploy(1, "triage");
      expect(replaced.permission).toBe("triage");
      yield* assertRemoved(fixtureNames[0]!, username);
      expect(
        (yield* directCollaborators(fixtureNames[1]!)).some(
          (member) => member.login === username,
        ),
      ).toBe(true);

      // Remove access independently while both retained repositories still exist.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* repository(0);
          yield* repository(1);
        }),
      );
      yield* assertRemoved(fixtureNames[1]!, username);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates collaborators only in dedicated test repositories",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(repository(2));
      const client = yield* Octokit;
      const { data: expected } = yield* Effect.tryPromise({
        try: () =>
          client.rest.repos.listCollaborators({
            owner,
            repo: fixtureNames[2]!,
            per_page: 100,
          }),
        catch: (error) => error as Error,
      });
      expect(expected.length).toBeGreaterThan(0);
      const credentials = yield* yield* GitHubCredentials;
      const provider = yield* Provider.findProvider(GitHub.Collaborator);
      // list() enumerates /user/repos; confine it to this suite's fixture.
      const listed = yield* provider.list().pipe(
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
                  options.url = url.toString();
                }
                if (
                  url.origin !== "https://api.github.com" ||
                  (url.pathname !== `/orgs/${owner}/repos` &&
                    url.pathname !==
                      `/repos/${owner}/${fixtureNames[2]!}/collaborators`)
                ) {
                  throw new Error(`Unsafe Collaborator list request: ${url}`);
                }
              });
              octokit.hook.after("request", (response, options) => {
                const url = new URL(options.url, "https://api.github.com");
                if (url.pathname === `/orgs/${owner}/repos`) {
                  response.data = (
                    response.data as Array<{ name: string }>
                  ).filter((repo) => repo.name === fixtureNames[2]!);
                }
              });
              return octokit;
            },
          }),
        ),
      );
      for (const member of expected) {
        expect(
          listed.some((collaborator) => collaborator.username === member.login),
        ).toBe(true);
      }
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

const mockCredentials = (calls: string[], access: Map<string, string>) =>
  Effect.succeed({
    token: Redacted.make("test-token"),
    octokit: () =>
      new OctokitClient({
        auth: "test-token",
        request: {
          fetch: (url: string | URL | Request, options?: RequestInit) =>
            Effect.runPromise(
              Effect.sync(() => {
                const path = new URL(String(url)).pathname;
                const method = options?.method ?? "GET";
                calls.push(`${method} ${path}`);
                if (
                  !/^\/repos\/alchemy-run-test\/alchemy-pr-1571-unit(?:-replacement)?\/collaborators\/test-member$/.test(
                    path,
                  )
                ) {
                  throw new Error(`Unexpected mock request ${method} ${path}`);
                }
                if (method === "PUT") {
                  access.set(
                    path,
                    JSON.parse(String(options?.body)).permission,
                  );
                  return new Response(null, { status: 204 });
                }
                if (method === "DELETE") {
                  const existed = access.delete(path);
                  return existed
                    ? new Response(null, { status: 204 })
                    : new Response(JSON.stringify({ message: "Not Found" }), {
                        status: 404,
                        headers: { "content-type": "application/json" },
                      });
                }
                throw new Error(`Unexpected mock method ${method}`);
              }),
            ),
        },
      }),
  });

const unitTest = (
  name: string,
  body: (
    stack: Test.ScratchStack,
    calls: string[],
    access: Map<string, string>,
  ) => Effect.Effect<void, any, any>,
) => {
  const calls: string[] = [];
  const access = new Map<string, string>();
  const { test } = Test.make({
    providers: Layer.succeed(
      GitHubCredentials,
      mockCredentials(calls, access),
    ).pipe(Layer.provideMerge(GitHub.providers({ baseUrl: "github.com" }))),
  });
  test.provider(name, (stack) => body(stack, calls, access));
};

unitTest(
  "unit: default permission, updates, replacement, and idempotent deletion",
  (stack, calls, access) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (
        repo: string,
        permission?: GitHub.CollaboratorProps["permission"],
      ) =>
        stack.deploy(
          GitHub.Collaborator("Collab", {
            owner: "alchemy-run-test",
            repository: repo,
            username: "test-member",
            permission,
          }).pipe(destroy()),
        );
      const created = yield* deploy("alchemy-pr-1571-unit");
      expect(created.permission).toBe("push");
      expect([...access.values()]).toEqual(["push"]);
      const updated = yield* deploy("alchemy-pr-1571-unit", "admin");
      expect(updated.permission).toBe("admin");
      expect([...access.values()]).toEqual(["admin"]);
      yield* deploy("alchemy-pr-1571-unit-replacement", "pull");
      expect([...access.keys()]).toEqual([
        "/repos/alchemy-run-test/alchemy-pr-1571-unit-replacement/collaborators/test-member",
      ]);
      expect([...access.values()]).toEqual(["pull"]);
      // Simulate out-of-band removal; the provider's DELETE must tolerate 404.
      access.clear();
      yield* stack.destroy();
      expect(calls.filter((call) => call.startsWith("DELETE "))).toHaveLength(
        2,
      );
      expect(access.size).toBe(0);
    }),
);

unitTest(
  "unit: collaborator defaults to retain on destroy",
  (stack, calls, access) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(
        GitHub.Collaborator("Collab", {
          owner: "alchemy-run-test",
          repository: "alchemy-pr-1571-unit",
          username: "test-member",
        }),
      );
      yield* stack.destroy();
      expect(access.size).toBe(1);
      expect(calls.some((call) => call.startsWith("DELETE "))).toBe(false);
    }),
);

test(
  "unit: owner allowlist rejects production and unrelated owners",
  Effect.sync(() => {
    expect(requireTestOwner("alchemy-run-test")).toBe("alchemy-run-test");
    expect(requireTestOwner("alchemy-run-test-2")).toBe("alchemy-run-test-2");
    for (const unsafe of ["alchemy-run", "sam-goodwin", "", "other-org"]) {
      expect(() => requireTestOwner(unsafe)).toThrow(
        "Refusing GitHub collaborator tests",
      );
    }
  }),
);
