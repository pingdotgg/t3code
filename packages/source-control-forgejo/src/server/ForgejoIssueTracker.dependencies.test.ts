import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { IssueDependenciesPage, type IssueDependencyDirection } from "@t3tools/contracts";
import type { IssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";

const BASE = "https://forgejo.test:3000/Mount";
const REF = { cwd: "/fixture", host: "forgejo.test:3000", scope: "Mount/Acme/Web", key: "42" };
const row = (number: number, pr = false, repository = "Other/Repo") => ({
  number,
  title: `Native ${number}`,
  html_url: `${BASE}/${repository}/${pr ? "pulls" : "issues"}/${number}`,
  state: number === 8 ? "closed" : "open",
  repository: {
    owner: repository.split("/")[0],
    name: repository.split("/")[1],
    full_name: repository,
  },
  ...(pr ? { pull_request: { merged: false } } : {}),
});
const repo = {
  full_name: "Acme/Web",
  has_issues: true,
  internal_tracker: { enable_issue_dependencies: true },
};
const decodePage = Schema.decodeEffect(IssueDependenciesPage);
type Call = { url: URL; method: string; body?: unknown };

function fixture<A, E>(
  run: (tracker: IssueTrackerApi, calls: Call[]) => Effect.Effect<A, E>,
  response: (call: Call) => {
    body?: unknown;
    headers?: string;
    status?: number;
    truncated?: boolean;
  } = () => ({}),
  baseUrl = BASE,
) {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const tracker = yield* ForgejoIssueTracker.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    return yield* run(tracker, calls);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP transport")),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git")
              return Effect.succeed(
                TestSourceControlHost.processOutput(`origin\t${baseUrl}/Acme/Web.git (fetch)\n`),
              );
            if (input.command !== "tea") return Effect.die(`Unexpected command ${input.command}`);
            if (input.args[0] === "login")
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify([
                    {
                      name: "wrong-mount",
                      url: `${new URL(baseUrl).origin}/mount`,
                      user: "other",
                      default: "true",
                    },
                    { name: "selected", url: baseUrl, user: "viewer", default: "false" },
                  ]),
                ),
              );
            expect(input.args[input.args.indexOf("--login") + 1]).toBe("selected");
            const call: Call = {
              url: new URL(input.args.at(-1)!),
              method: input.args[input.args.indexOf("--method") + 1]!,
              ...(input.stdin ? { body: JSON.parse(input.stdin) } : {}),
            };
            expect(call.url.origin).toBe(new URL(baseUrl).origin);
            expect(
              call.url.pathname.startsWith(
                `${new URL(baseUrl).pathname.replace(/\/$/, "")}/api/v1/`,
              ),
            ).toBe(true);
            calls.push(call);
            const reply = response(call);
            const own = call.url.pathname.includes("/Acme/Web");
            const payload =
              reply.body ??
              (/\/issues\/\d+$/.test(call.url.pathname)
                ? row(
                    Number(call.url.pathname.split("/").at(-1)),
                    false,
                    own ? "Acme/Web" : "Other/Repo",
                  )
                : { ...repo, full_name: own ? "Acme/Web" : "Other/Repo" });
            return Effect.succeed({
              ...TestSourceControlHost.processOutput(JSON.stringify(payload), {
                stderr: `HTTP/1.1 ${reply.status ?? 200}\n${reply.headers ?? ""}`,
              }),
              stdoutTruncated: reply.truncated ?? false,
            });
          },
        },
      }),
    ),
  );
}

it.effect.each([
  {
    source: "https://codeberg.org/api/v1/repos/forgejo/forgejo/issues/14851",
    baseUrl: "https://codeberg.org",
    issue: {
      number: 14851,
      title: "chore(release-notes): Forgejo v17.0.0 [skip ci]",
      state: "closed",
      html_url: "https://codeberg.org/forgejo/forgejo/pulls/14851",
      repository: { id: 73144, name: "forgejo", owner: "forgejo", full_name: "forgejo/forgejo" },
      pull_request: {
        merged: true,
        merged_at: "2026-10-15T18:30:14+02:00",
        draft: false,
        html_url: "https://codeberg.org/forgejo/forgejo/pulls/14851",
      },
    },
  },
  {
    source: "https://gitea.com/api/v1/repos/gitea/tea/issues/899",
    baseUrl: "https://gitea.com",
    issue: {
      number: 899,
      title: "Fix issue detail view ignoring --owner flag",
      state: "closed",
      html_url: "https://gitea.com/gitea/tea/pulls/899",
      repository: { id: 550, name: "tea", owner: "gitea", full_name: "gitea/tea" },
      pull_request: {
        merged: true,
        merged_at: "2026-02-19T18:57:24Z",
        draft: false,
        html_url: "https://gitea.com/gitea/tea/pulls/899",
      },
    },
  },
])(
  "decodes the public native fixture from $source through the real CLI adapter",
  ({ baseUrl, issue }) =>
    fixture(
      (tracker, calls) =>
        Effect.gen(function* () {
          const result = yield* tracker.getDependencies!({
            cwd: "/fixture",
            host: new URL(baseUrl).host,
            scope: issue.repository.full_name,
            key: "1",
            direction: "blocks",
          }).pipe(Effect.flatMap(decodePage));
          expect(result.items).toMatchObject([
            {
              scope: issue.repository.full_name,
              key: String(issue.number),
              kind: "pull-request",
              url: issue.html_url,
              state: { category: "closed" },
            },
          ]);
          expect(calls).toHaveLength(1);
        }),
      () => ({ body: [issue] }),
      baseUrl,
    ),
);

it.effect.each(["blocks", "blocked-by"] as const)(
  "reads native issue and PR %s without hierarchy",
  (direction) =>
    fixture(
      (tracker, calls) =>
        Effect.gen(function* () {
          expect(tracker.capabilities).toMatchObject({
            dependencies: true,
            subIssues: false,
            createSubIssue: false,
            updateParent: false,
          });
          const result = yield* tracker.getDependencies!({ ...REF, direction }).pipe(
            Effect.flatMap(decodePage),
          );
          expect(
            result.items.map((item) => [item.scope, item.key, item.kind, item.state.category]),
          ).toEqual([
            ["Mount/Other/Repo", "7", "issue", "open"],
            ["Mount/Other/Repo", "8", "pull-request", "closed"],
          ]);
          expect(result.items[1]).toMatchObject({
            externalOnly: true,
            url: `${BASE}/Other/Repo/pulls/8`,
          });
          expect(result.nextCursor).toBe("2");
          expect(calls).toHaveLength(1);
          expect(calls[0]!.url.pathname).toBe(
            `/Mount/api/v1/repos/Acme/Web/issues/42/${direction === "blocks" ? "blocks" : "dependencies"}`,
          );
        }),
      () => ({
        body: [row(7), row(8, true)],
        headers: `Link: <${BASE}/api/v1/repos/Acme/Web/issues/42/${direction === "blocks" ? "blocks" : "dependencies"}?limit=50&page=2>; rel="next"\n`,
      }),
    ),
);

it.effect.each([
  { name: "hidden empty", body: [], headers: "", next: "2", truncated: true },
  { name: "hidden placeholder", body: [{}], headers: "", next: "2", truncated: true },
  {
    name: "native HIDDEN placeholder",
    body: [{ number: 0, title: "HIDDEN", html_url: "", state: "", user: null }],
    headers: "",
    next: "2",
    truncated: true,
  },
  { name: "short visible", body: [row(7)], headers: "", next: "2", truncated: true },
  {
    name: "physical count still has hidden rows",
    body: [],
    headers: "X-Total-Count: 4\n",
    next: "2",
    truncated: true,
  },
  {
    name: "count proves empty",
    body: [],
    headers: "X-Total-Count: 0\n",
    next: null,
    truncated: false,
  },
  {
    name: "count proves first page whole",
    body: [row(7)],
    headers: "X-Total-Count: 1\n",
    next: null,
    truncated: false,
  },
  {
    name: "valid next on empty",
    body: [],
    headers: `Link: <${BASE}/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=2>; rel="next"\n`,
    next: "2",
    truncated: false,
  },
  {
    name: "valid last",
    body: [row(7)],
    headers: `Link: <${BASE}/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=1>; rel="last"\n`,
    next: null,
    truncated: false,
  },
  {
    name: "native owner and repo case",
    body: [],
    headers: `Link: <${BASE}/api/v1/repos/acme/web/issues/42/blocks?limit=50&page=1>; rel="last"\n`,
    next: null,
    truncated: false,
  },
])("keeps physical paging honest for $name", ({ body, headers, next, truncated }) =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        const result = yield* tracker.getDependencies!({ ...REF, direction: "blocks" }).pipe(
          Effect.flatMap(decodePage),
        );
        expect(result).toMatchObject({ nextCursor: next, truncated });
        expect(result.items).toHaveLength(
          body.length && "number" in body[0]! && body[0]!.number === 7 ? 1 : 0,
        );
        expect(calls).toHaveLength(1);
      }),
    () => ({ body, headers }),
  ),
);

it.effect("reads page two without scanning and keeps an empty page uncertain", () =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        const result = yield* tracker.getDependencies!({
          ...REF,
          direction: "blocks",
          cursor: "2",
        });
        expect(result).toMatchObject({ items: [], nextCursor: "3", truncated: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url.searchParams.get("page")).toBe("2");
      }),
    () => ({ body: [] }),
  ),
);

it.effect("honors one-row requests despite the native blocks minimum page size", () =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        const first = yield* tracker.getDependencies!({ ...REF, direction: "blocks", limit: 1 });
        expect(first.items.map((item) => item.key)).toEqual(["7"]);
        const second = yield* tracker.getDependencies!({
          ...REF,
          direction: "blocks",
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.items.map((item) => item.key)).toEqual(["8"]);
        expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "1"]);
        expect(calls.every((call) => call.url.searchParams.get("limit") === "50")).toBe(true);
      }),
    () => ({ body: [row(7), row(8)] }),
  ),
);

it.effect.each([
  {
    name: "external origin",
    url: "https://evil.test/Mount/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=2",
  },
  {
    name: "wrong port",
    url: "https://forgejo.test:3001/Mount/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=2",
  },
  {
    name: "wrong mount case",
    url: `${BASE.replace("Mount", "mount")}/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=2`,
  },
  {
    name: "wrong direction",
    url: `${BASE}/api/v1/repos/Acme/Web/issues/42/dependencies?limit=50&page=2`,
  },
  { name: "wrong issue", url: `${BASE}/api/v1/repos/Acme/Web/issues/43/blocks?limit=50&page=2` },
  {
    name: "wrong query",
    url: `${BASE}/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=2&token=bad`,
  },
  { name: "wrong limit", url: `${BASE}/api/v1/repos/Acme/Web/issues/42/blocks?limit=10&page=2` },
  { name: "skipped page", url: `${BASE}/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=3` },
  {
    name: "duplicate query",
    url: `${BASE}/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=2&page=2`,
  },
])("rejects $name Link without following it", ({ url }) =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(tracker.getDependencies!({ ...REF, direction: "blocks" })),
        ).toMatchObject({ operation: "getDependencies", reason: "failed" });
        expect(calls).toHaveLength(1);
      }),
    () => ({ body: [], headers: `Link: <${url}>; rel="next"\n` }),
  ),
);

it.effect.each([
  { name: "malformed row", body: [{ number: "7", title: "bad" }] },
  { name: "incomplete retained native row", body: [{ id: 7 }] },
  {
    name: "foreign row mount",
    body: [{ ...row(7), html_url: row(7).html_url.replace("/Mount/", "/mount/") }],
  },
  {
    name: "foreign row host",
    body: [{ ...row(7), html_url: row(7).html_url.replace("forgejo.test", "evil.test") }],
  },
  {
    name: "wrong row repository",
    body: [{ ...row(7), repository: { owner: "wrong", name: "repo", full_name: "wrong/repo" } }],
  },
  { name: "wrong PR kind", body: [{ ...row(7), pull_request: { merged: false } }] },
  {
    name: "wrong native route case",
    body: [{ ...row(7), html_url: row(7).html_url.replace("/issues/", "/ISSUES/") }],
  },
  {
    name: "nested native repository",
    body: [
      {
        ...row(7),
        repository: { owner: "Mount/Other", name: "Repo", full_name: "Mount/Other/Repo" },
      },
    ],
  },
  { name: "malformed link", body: [], headers: "Link: broken\n" },
  { name: "inconsistent count", body: [row(7)], headers: "X-Total-Count: 0\n" },
  {
    name: "inconsistent count and link",
    body: [],
    headers: `X-Total-Count: 0\nLink: <${BASE}/api/v1/repos/Acme/Web/issues/42/blocks?limit=50&page=2>; rel="next"\n`,
  },
  { name: "malformed count", body: [], headers: "X-Total-Count: unknown\n" },
  { name: "oversized response", body: [], truncated: true },
])("fails on $name rather than returning empty", (reply) =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(tracker.getDependencies!({ ...REF, direction: "blocks" })),
        ).toMatchObject({ reason: "failed" });
        expect(calls).toHaveLength(1);
      }),
    () => reply,
  ),
);

it.effect.each([401, 403, 404, 429])("preserves native read denial %s", (status) =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(tracker.getDependencies!({ ...REF, direction: "blocked-by" })),
        ).toMatchObject({ cause: { httpStatus: status } });
        expect(calls).toHaveLength(1);
      }),
    () => ({ body: { message: "native denial" }, status }),
  ),
);

it.effect.each([
  { direction: "blocks", linked: true },
  { direction: "blocks", linked: false },
  { direction: "blocked-by", linked: true },
  { direction: "blocked-by", linked: false },
] satisfies { direction: IssueDependencyDirection; linked: boolean }[])(
  "changes one native $direction edge linked=$linked",
  ({ direction, linked }) =>
    fixture((tracker, calls) =>
      Effect.gen(function* () {
        yield* tracker.setDependency!({
          ...REF,
          direction,
          targetScope: "Mount/Other/Repo",
          targetKey: "7",
          linked,
        });
        const writes = calls.filter((call) => call.method !== "GET");
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
          method: linked ? "POST" : "DELETE",
          body: { owner: "Other", repo: "Repo", index: 7 },
        });
        expect(writes[0]!.url.pathname).toBe(
          `/Mount/api/v1/repos/Acme/Web/issues/42/${direction === "blocks" ? "blocks" : "dependencies"}`,
        );
        expect(calls).toHaveLength(5);
      }),
    ),
);

it.effect.each([
  { name: "wrong target mount", targetScope: "mount/Other/Repo" },
  { name: "root target from mounted source", targetScope: "Other/Repo" },
  { name: "foreign host scope", targetScope: "https://evil.test/Other/Repo" },
  { name: "path traversal", targetScope: "Mount/../Repo" },
  { name: "invalid target number", targetKey: "7x" },
  { name: "unsafe target number", targetKey: "9007199254740993" },
])("does not mutate for $name", ({ targetScope = "Mount/Other/Repo", targetKey = "7" }) =>
  fixture((tracker, calls) =>
    Effect.gen(function* () {
      yield* Effect.flip(
        tracker.setDependency!({
          ...REF,
          direction: "blocks",
          targetScope,
          targetKey,
          linked: true,
        }),
      );
      expect(calls).toHaveLength(0);
    }),
  ),
);

it.effect.each([
  { name: "archived source", response: { ...repo, archived: true } },
  { name: "disabled source issues", response: { ...repo, has_issues: false } },
  {
    name: "disabled target dependencies",
    response: { ...repo, internal_tracker: { enable_issue_dependencies: false } },
  },
])("does not mutate for $name", ({ response }) =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        yield* Effect.flip(
          tracker.setDependency!({
            ...REF,
            direction: "blocked-by",
            targetScope: "Mount/Other/Repo",
            targetKey: "7",
            linked: true,
          }),
        );
        expect(calls.every((call) => call.method === "GET")).toBe(true);
      }),
    (call) => (call.url.pathname.endsWith("/Acme/Web") ? { body: response } : {}),
  ),
);

it.effect.each([400, 403, 404, 409, 422])(
  "keeps native mutation error %s without retry",
  (status) =>
    fixture(
      (tracker, calls) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.flip(
              tracker.setDependency!({
                ...REF,
                direction: "blocks",
                targetScope: "Mount/Other/Repo",
                targetKey: "7",
                linked: true,
              }),
            ),
          ).toMatchObject({ cause: { httpStatus: status } });
          expect(calls.filter((call) => call.method !== "GET")).toHaveLength(1);
        }),
      (call) =>
        call.method === "GET"
          ? {}
          : {
              status,
              body: { message: "native cross-repo, cycle, token, or confidentiality refusal" },
            },
    ),
);

it.effect.each([
  { name: "source mount case", scope: "mount/Acme/Web", key: "42" },
  { name: "source number overflow", scope: REF.scope, key: "9007199254740993" },
  { name: "source path traversal", scope: "Mount/../Web", key: "42" },
])("makes no API request for invalid $name", ({ scope, key }) =>
  fixture((tracker, calls) =>
    Effect.gen(function* () {
      yield* Effect.flip(tracker.getDependencies!({ ...REF, scope, key, direction: "blocks" }));
      expect(calls).toHaveLength(0);
    }),
  ),
);

it.effect.each([
  { name: "foreign source issue", path: "/issues/42", body: row(43, false, "Acme/Web") },
  { name: "hidden target issue", path: "/issues/7", body: {} },
  { name: "foreign target issue", path: "/issues/7", body: row(7, false, "Wrong/Repo") },
  {
    name: "foreign source repo",
    path: "/repos/Acme/Web",
    body: { ...repo, full_name: "Wrong/Repo" },
  },
  {
    name: "foreign target repo",
    path: "/repos/Other/Repo",
    body: { ...repo, full_name: "Wrong/Repo" },
  },
  { name: "source PR", path: "/issues/42", body: row(42, true, "Acme/Web") },
  {
    name: "target dependency flag",
    path: "/repos/Other/Repo",
    body: {
      ...repo,
      full_name: "Other/Repo",
      internal_tracker: { enable_issue_dependencies: false },
    },
  },
])("refuses $name before any edge mutation", ({ path, body }) =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        yield* Effect.flip(
          tracker.setDependency!({
            ...REF,
            direction: "blocks",
            targetScope: "Mount/Other/Repo",
            targetKey: "7",
            linked: true,
          }),
        );
        expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
      }),
    (call) => (call.url.pathname.endsWith(path) ? { body } : {}),
  ),
);

it.effect.each(["/repos/Acme/Web", "/issues/42", "/repos/Other/Repo", "/issues/7"])(
  "keeps a native read 403 at %s from reaching an edge mutation",
  (path) =>
    fixture(
      (tracker, calls) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.flip(
              tracker.setDependency!({
                ...REF,
                direction: "blocks",
                targetScope: "Mount/Other/Repo",
                targetKey: "7",
                linked: true,
              }),
            ),
          ).toMatchObject({ cause: { httpStatus: 403 } });
          expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
        }),
      (call) =>
        call.url.pathname.endsWith(path)
          ? { status: 403, body: { message: "native read denied" } }
          : {},
    ),
);

it.effect.each(["blocks", "blocked-by"] as const)("keeps a native PR target for %s", (direction) =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        yield* tracker.setDependency!({
          ...REF,
          direction,
          targetScope: "Mount/Other/Repo",
          targetKey: "7",
          linked: true,
        });
        expect(calls.filter((call) => call.method !== "GET")).toHaveLength(1);
      }),
    (call) => (call.url.pathname.endsWith("/issues/7") ? { body: row(7, true) } : {}),
  ),
);

it.effect("can remove a returned mounted edge from a legacy implicit source scope", () =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        const input = { ...REF, scope: "Acme/Web" };
        const result = yield* tracker.getDependencies!({ ...input, direction: "blocks" });
        yield* tracker.setDependency!({
          ...input,
          direction: "blocks",
          targetScope: result.items[0]!.scope,
          targetKey: result.items[0]!.key,
          linked: false,
        });
        expect(calls).toHaveLength(6);
        expect(calls.at(-1)).toMatchObject({
          method: "DELETE",
          body: { owner: "Other", repo: "Repo", index: 7 },
        });
      }),
    (call) =>
      call.method === "GET" && call.url.pathname.endsWith("/blocks") ? { body: [row(7)] } : {},
  ),
);

it.effect("folds only owner and repo when changing a same-repo edge", () =>
  fixture(
    (tracker, calls) =>
      Effect.gen(function* () {
        yield* tracker.setDependency!({
          ...REF,
          direction: "blocks",
          targetScope: "Mount/acme/web",
          targetKey: "7",
          linked: false,
        });
        expect(calls).toHaveLength(4);
        expect(calls.at(-1)).toMatchObject({
          method: "DELETE",
          body: { owner: "acme", repo: "web", index: 7 },
        });
      }),
    (call) => (call.url.pathname.endsWith("/issues/7") ? { body: row(7, false, "Acme/Web") } : {}),
  ),
);
