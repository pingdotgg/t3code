import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";
import {
  ForgejoTimelineEntry,
  ForgejoConversationCursor,
  forgejoIssueEvent,
} from "./forgejoIssueJson.ts";

const encode = (value: unknown) => JSON.stringify(value);
const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);
const decodeTimelineEntry = Schema.decodeSync(ForgejoTimelineEntry);
const decodeConversationCursor = Schema.decodeSync(
  Schema.fromJsonString(ForgejoConversationCursor),
);

const ISSUE = {
  number: 42,
  title: "Composer loses focus",
  body: "Typing drops focus.",
  html_url: "https://forgejo.test:3000/acme/web/issues/42",
  user: { login: "octocat", full_name: "Octo Cat", avatar_url: "" },
  state: "open",
  created_at: "2026-07-01T00:00:00+02:00",
  updated_at: "2026-07-03T00:00:00Z",
  closed_at: null,
  assignees: [{ login: "theo" }],
  labels: [{ id: 3, name: "bug", color: "d73a4a" }],
  comments: 1,
  is_locked: true,
};

const CONTACT_LINK = {
  name: "Support",
  about: "Get help",
  url: "https://support.example.test/help",
};

describe("Forgejo comment ordering", () => {
  it("keeps native event and source URLs distinct and rejects unsafe links", () => {
    const source = {
      number: 50,
      title: "Native source",
      html_url: "https://other.test/team/repo/pulls/50",
    };
    const native = {
      id: 7,
      type: "pull_ref",
      created_at: "2026-10-16T00:00:00Z",
      html_url: "https://forgejo.test/acme/web/issues/42#issuecomment-7",
      ref_issue: source,
    };
    const event = forgejoIssueEvent(decodeTimelineEntry(native));
    expect(event).toMatchObject({
      url: native.html_url,
      reference: { url: source.html_url, title: "Native source", identifier: "#50" },
    });
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,test",
      "/relative",
      "https://user:secret@example.test/path",
    ]) {
      const unsafe = forgejoIssueEvent({
        ...native,
        html_url: url,
        ref_issue: { ...source, html_url: url },
      });
      expect(unsafe).not.toHaveProperty("url");
      expect(unsafe).not.toHaveProperty("reference");
    }
    expect(
      forgejoIssueEvent({ id: 9, type: "close", created_at: native.created_at }),
    ).not.toHaveProperty("url");
  });

  it.effect(
    "continues native history without duplicates and keeps filtered completion unknown",
    () =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const page = Number(new URL(input.path, "https://forgejo.test").searchParams.get("page"));
          return {
            stdout: encode(
              page === 1
                ? [{ id: 20, type: "close", created_at: "2026-10-01T00:00:00Z" }]
                : [{ id: 10, type: "reopen", created_at: "2026-10-02T00:00:00Z" }],
            ),
            stderr: page === 1 ? 'Link: </next>; rel="next"' : "X-Total-Count: 1",
          };
        });
        const input = {
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "Mount/acme/web",
          key: "42",
          order: "asc" as const,
          limit: 1,
        };
        const first = yield* api.getHistory!(input);
        const second = yield* api.getHistory!({
          ...input,
          host: "FORGEJO.TEST:3000",
          cursor: first.nextCursor!,
        });
        expect([...first.items, ...second.items].map((row) => row.id)).toEqual(["20", "10"]);
        expect(second.truncated).toBe(true);
        expect(paths).toHaveLength(2);
        const third = yield* api.getHistory!({ ...input, cursor: second.nextCursor! }).pipe(
          Effect.flip,
        );
        expect(third.reason).toBe("failed");
        expect(paths).toHaveLength(3);
      }),
  );

  it.effect.each([
    "X-Total-Count: invalid",
    "X-Total-Count: 1\nX-Total-Count: 1",
    "X-Total-Count: 0",
  ])("refuses contradictory comment totals %s without reaction reads", (stderr) =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode([
            { id: 1, body: "Comment", user: null, created_at: "2026-10-01T00:00:00Z" },
          ]),
          stderr,
        };
      });
      yield* api
        .getComments({
          cwd: "/w",
          host: "forgejo.test",
          scope: "acme/web",
          key: "42",
          order: "asc",
        })
        .pipe(Effect.flip);
      expect(paths).toHaveLength(1);
    }),
  );

  it.effect("refuses out-of-range native cursor windows before HTTP", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const rows = Array.from({ length: 60 }, (_, index) => ({
        id: index + 1,
        body: "Comment",
        user: null,
        created_at: "2026-10-01T00:00:00Z",
      }));
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode(input.path.includes("/42/comments?") ? rows : []),
          stderr: "X-Total-Count: 60",
        };
      });
      const input = { cwd: "/w", host: "forgejo.test", scope: "acme/web", key: "42" };
      const first = yield* api.getComments(input);
      const state = decodeConversationCursor(first.nextCursor!);
      paths.length = 0;
      for (const native of [
        "offset:1:60",
        "offset:1:999",
        "offset:0:50",
        "page:99999999:50",
        "2",
      ]) {
        yield* api
          .getComments({ ...input, cursor: JSON.stringify({ ...state, native }) })
          .pipe(Effect.flip);
      }
      expect(paths).toEqual([]);
    }),
  );
  it.effect.each(["asc", "desc"] as const)(
    "reads true %s across a complete native conversation",
    (order) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const rows = Array.from({ length: 120 }, (_, index) => ({
          id: index + 1,
          body: "Comment",
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (input.path.startsWith("repos/acme/web/issues/42/comments?"))
            return { stdout: encode(rows), stderr: "X-Total-Count: 120" };
          if (/\/issues\/comments\/\d+\/reactions$/.test(input.path)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = yield* api.getComments({
            ...target,
            order,
            ...(cursor === undefined ? {} : { cursor }),
          });
          ids.push(...page.comments.map((row) => row.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined && ids.length <= 120);
        expect(ids).toEqual(
          Array.from({ length: 120 }, (_, index) =>
            String(order === "desc" ? 120 - index : index + 1),
          ),
        );
        expect(cursor).toBeUndefined();
        expect(paths.filter((path) => /\/42\/comments\?/.test(path))).toHaveLength(3);
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(120);
      }),
  );

  it.effect("rejects changed cursor context before native reads", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return input.path.includes("timeline")
          ? {
              stdout: encode([{ id: 1, type: "close", created_at: "2026-07-02T00:00:00Z" }]),
              stderr: 'Link: </next>; rel="next"',
            }
          : answer(input.path);
      });
      const target = {
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        connectionId: "account-a",
        order: "asc" as const,
      };
      for (const method of ["getComments", "getHistory"] as const) {
        const read = (input: Parameters<typeof api.getComments>[0]) =>
          method === "getComments"
            ? api.getComments(input).pipe(Effect.map((page) => page.nextCursor))
            : api.getHistory!(input).pipe(Effect.map((page) => page.nextCursor));
        const cursor = (yield* read(target))!;
        expect(cursor).toBeTruthy();
        paths.length = 0;
        for (const change of [
          { connectionId: "account-b" },
          { cwd: "/else" },
          { host: "other.test" },
          { scope: "other/repo" },
          { key: "43" },
          { order: "desc" as const },
          { cursor: "2" },
          { cursor: cursor + "x" },
        ]) {
          yield* read({ ...target, cursor, ...change }).pipe(Effect.flip);
        }
        expect(paths).toEqual([]);
        const { connectionId: _connectionId, ...defaultTarget } = target;
        yield* read({ ...defaultTarget, cursor }).pipe(Effect.flip);
        expect(paths).toEqual([]);
      }
    }),
  );

  it.effect("refuses newest history before reading a native oldest-first timeline", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return { stdout: "[]" };
      });
      const error = yield* api.getHistory!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      }).pipe(Effect.flip);
      expect(error.reason).toBe("failed");
      expect(paths).toEqual([]);
    }),
  );
});

/** Every endpoint the detail read touches, answered by path; stderr carries the `Link` header. */
function answer(path: string): { readonly stdout: string; readonly stderr?: string } {
  const [route] = path.split("?");
  switch (route) {
    case "user":
      return { stdout: encode({ login: "julius" }) };
    case "repos/acme/web":
      return {
        stdout: encode({ full_name: "acme/web", permissions: { push: false, admin: false } }),
      };
    case "repos/acme/web/issues/42":
      return { stdout: encode(ISSUE) };
    case "repos/acme/web/issues/42/timeline":
      return {
        stdout: encode([
          {
            id: 1,
            type: "label",
            body: "1",
            user: { login: "theo" },
            created_at: "2026-07-01T01:00:00Z",
            label: { id: 3, name: "bug" },
          },
          {
            id: 2,
            type: "comment",
            body: "Repro attached.",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
          },
          {
            id: 3,
            type: "pull_ref",
            user: { login: "theo" },
            created_at: "2026-07-02T01:00:00Z",
            ref_issue: {
              number: 50,
              html_url: "https://forgejo.test:3000/acme/web/pulls/50",
              pull_request: { merged: false },
            },
          },
          { id: 4, type: "milestone", user: { login: "theo" }, created_at: "2026-07-02T02:00:00Z" },
        ]),
      };
    case "repos/acme/web/issues/42/reactions":
      return { stdout: encode([{ content: "eyes", user: { login: "theo" } }]) };
    case "repos/acme/web/issues/42/comments":
      return {
        stdout: encode([
          {
            id: 7,
            body: "Repro attached.",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
            html_url: "https://forgejo.test:3000/acme/web/issues/42#issuecomment-7",
          },
        ]),
        stderr:
          'HTTP/1.1 200\nlink: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/comments?page=2>; rel="next"\n',
      };
    case "repos/acme/web/issues/comments/7/reactions":
      return {
        stdout: encode([
          { content: "+1", user: { login: "julius" } },
          { content: "+1", user: { login: "theo" } },
        ]),
      };
    case "repos/acme/web/pulls/50":
      return {
        stdout: encode({
          number: 50,
          title: "fix(web): keep composer focus",
          html_url: "https://forgejo.test:3000/acme/web/pulls/50",
          state: "open",
          merged: false,
          draft: true,
        }),
      };
    default:
      throw new Error(`unexpected path ${path}`);
  }
}

function tracker(
  onApi: (input: ForgejoCli.ForgejoApiInput) =>
    | {
        readonly stdout: string;
        readonly stderr?: string;
        readonly stdoutTruncated?: boolean;
        readonly repositoryUrl?: string;
      }
    | ForgejoCli.ForgejoCliError,
) {
  return ForgejoIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          const result = onApi(input);
          if (isForgejoCliError(result)) return Effect.fail(result);
          const { stdout, stderr, stdoutTruncated, repositoryUrl } = result;
          return Effect.succeed({
            ...TestSourceControlHost.processOutput(stdout, { stderr: stderr ?? "" }),
            stdoutTruncated: stdoutTruncated ?? false,
            ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
          });
        },
      }),
    ),
  );
}

describe("ForgejoIssueTracker", () => {
  it.effect.each([
    { values: ["3"], ids: [13] },
    { values: ["forgejo-label:3"], ids: [3] },
    { values: ["3", "forgejo-label:3"], ids: [13, 3] },
  ])("keeps native label tokens distinct from numeric names: $values", ({ values, ids }) =>
    Effect.gen(function* () {
      for (const operation of ["create", "update"] as const) {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method || input.path.endsWith("/issues/42")) return { stdout: encode(ISSUE) };
          return {
            stdout: encode([
              { id: 3, name: "bug" },
              { id: 13, name: "3" },
            ]),
          };
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        if (operation === "create")
          yield* api.create!({ ...target, title: "New", body: "", labels: values, assignees: [] });
        else yield* api.update!({ ...target, labels: values });
        expect(requests.filter((request) => request.method)).toMatchObject([
          { body: { labels: ids } },
        ]);
        expect(requests).toHaveLength(operation === "create" ? 2 : 3);
      }
    }),
  );

  it.effect.each([
    "not-found",
    "foreign-id",
    "wrong-id",
    "authentication",
    "rate-limit",
    "forbidden",
  ] as const)("refuses scoped native ID resolution %s before any fields change", (reason) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.path === "repos/Mount/acme/web/issues/42") return { stdout: encode(ISSUE) };
        if (input.path.includes("?")) return { stdout: "[]", stderr: 'Link: </last>; rel="last"' };
        if (reason === "wrong-id") return { stdout: encode({ id: 100, name: "99" }) };
        return new ForgejoCli.ForgejoCliError({
          command: "tea",
          cwd: "/w",
          reason: reason === "foreign-id" ? "not-found" : reason,
          detail:
            reason === "foreign-id"
              ? "Label 99 belongs to other/repo."
              : "Native scoped label refused.",
        });
      });
      const error = yield* Effect.flip(
        api.update!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "Mount/acme/web",
          key: "42",
          title: "Changed",
          labels: ["forgejo-label:99"],
        }),
      );
      expect(error.reason).toBe(
        reason === "authentication"
          ? "unauthenticated"
          : reason === "rate-limit"
            ? "rate-limited"
            : "failed",
      );
      expect(requests.filter((request) => request.method)).toEqual([]);
      expect(
        requests
          .filter((request) => /\/labels\/[^/?]+$/.test(request.path))
          .map((request) => request.path),
      ).toEqual(
        reason === "not-found" || reason === "foreign-id"
          ? ["repos/Mount/acme/web/labels/99", "orgs/acme/labels/99"]
          : ["repos/Mount/acme/web/labels/99"],
      );
      expect(requests).toHaveLength(reason === "not-found" || reason === "foreign-id" ? 5 : 4);
      expect(requests.every((request) => request.repository === "Mount/acme/web")).toBe(true);
    }),
  );

  it.effect.each([
    { operation: "create", name: "BUG" },
    { operation: "update", name: "BUG" },
    { operation: "create", name: "bug" },
    { operation: "update", name: "bug" },
  ] as const)("applies native template label $name on $operation", ({ operation, name }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.method || input.path.endsWith("/issues/42")) return { stdout: encode(ISSUE) };
        if (input.path.endsWith("/issue_templates"))
          return {
            stdout: encode([
              { file_name: "bug.md", name: "Bug", content: "Steps", labels: [name] },
            ]),
          };
        if (input.path.endsWith("/issue_config")) return { stdout: "{}" };
        return { stdout: encode(input.path.startsWith("repos/") ? ISSUE.labels : []) };
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      const template = (yield* api.listTemplates!(target)).templates[0]!;
      expect(template.labels).toEqual([name]);
      requests.length = 0;
      if (operation === "create")
        yield* api.create!({
          ...target,
          title: "Bug",
          body: template.body,
          labels: template.labels,
          assignees: [],
          templateKey: template.key,
        });
      else yield* api.update!({ ...target, labels: template.labels });
      expect(requests.filter((request) => request.method)).toMatchObject([
        { body: { labels: [3] } },
      ]);
      expect(requests).toHaveLength(operation === "create" ? 2 : 3);
    }),
  );

  it.effect.each([
    { requested: "BUG", native: "bug", matches: true },
    { requested: "Σ", native: "ς", matches: true },
    { requested: "S", native: "ſ", matches: true },
    { requested: "K", native: "k", matches: true },
    { requested: "BUG[1].*", native: "bug[1].*", matches: true },
    { requested: "BUG[1].*", native: "bug1-other", matches: false },
    { requested: "BUG", native: "bug\n", matches: false },
    { requested: "SS", native: "ß", matches: false },
    { requested: "İ", native: "i", matches: false },
    { requested: "BUG", native: "unrelated", matches: false },
  ])("validates scoped native label $requested against $native", ({ requested, native, matches }) =>
    Effect.gen(function* () {
      for (const source of ["repo", "org"] as const) {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method) return { stdout: encode(ISSUE) };
          if (input.path.includes("?")) return { stdout: "[]" };
          if (source === "org" && input.path.startsWith("repos/"))
            return new ForgejoCli.ForgejoCliError({
              command: "fj",
              cwd: "/w",
              reason: "not-found",
              detail: "No repository label.",
            });
          return { stdout: encode({ id: 93, name: native }) };
        });
        const result = yield* Effect.result(
          api.create!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            title: "Bug",
            body: "",
            labels: [requested],
            assignees: [],
          }),
        );
        expect(Result.isSuccess(result)).toBe(matches);
        const writes = requests.filter((request) => request.method);
        if (matches) expect(writes).toMatchObject([{ body: { labels: [93] } }]);
        else expect(writes).toEqual([]);
        expect(requests).toHaveLength(3 + Number(source === "org") + Number(matches));
        expect(requests[2]?.path).toBe(`repos/acme/web/labels/${encodeURIComponent(requested)}`);
      }
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "prefers a page-two repository label over a same-name organization label on %s",
    (operation) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method) return { stdout: encode(ISSUE) };
          if (input.path === "repos/acme/web/issues/42")
            return { stdout: encode({ ...ISSUE, labels: [] }) };
          if (input.path.startsWith("orgs/acme/labels"))
            return { stdout: encode([{ id: 99, name: "bug" }]) };
          return {
            stdout: encode(
              input.path.includes("page=2")
                ? [{ id: 93, name: "bug" }]
                : [{ id: 4, name: "enhancement" }],
            ),
            stderr: `Link: <https://forgejo.test/labels?page=2>; rel="${input.path.includes("page=2") ? "last" : "next"}"`,
          };
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        if (operation === "create")
          yield* api.create!({ ...target, title: "New", body: "", labels: ["BUG"], assignees: [] });
        else yield* api.update!({ ...target, labels: ["BUG"] });
        expect(requests.filter((request) => request.method)).toMatchObject([
          { body: { labels: [93] } },
        ]);
        expect(requests.map((request) => request.path)).toContain(
          "repos/acme/web/labels?limit=50&page=2",
        );
        expect(requests).toHaveLength(operation === "create" ? 4 : 5);
      }),
  );

  it.effect("preserves an applied organization label over a same-name repository label", () =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.method) return { stdout: "[]" };
        return {
          stdout: encode(
            input.path === "repos/acme/web/issues/42"
              ? { ...ISSUE, labels: [{ id: 99, name: "bug" }] }
              : [{ id: 93, name: "bug" }],
          ),
        };
      });
      yield* api.update!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        labels: ["BUG"],
      });
      expect(requests.filter((request) => request.method)).toMatchObject([
        { body: { labels: [99] } },
      ]);
      expect(requests).toHaveLength(3);
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "resolves organization collisions beyond the page budget before %s",
    (operation) =>
      Effect.gen(function* () {
        for (const resolution of ["repo", "org", "rate-limit", "wrong-name", "numeric"] as const) {
          const requests: ForgejoCli.ForgejoApiInput[] = [];
          const name = resolution === "numeric" ? "12" : "BUG";
          const api = yield* tracker((input) => {
            requests.push(input);
            if (input.method) return { stdout: encode(ISSUE) };
            if (input.path === "repos/acme/web/issues/42")
              return { stdout: encode({ ...ISSUE, labels: [] }) };
            const [route] = input.path.split("?");
            if (route === "orgs/acme/labels")
              return { stdout: encode([{ id: 99, name: name.toLowerCase() }]) };
            if (route === "repos/acme/web/labels")
              return {
                stdout: encode([{ id: 4, name: "enhancement" }]),
                stderr: 'Link: <https://forgejo.test/labels?page=4>; rel="next"',
              };
            if (resolution === "rate-limit" || resolution === "org")
              return new ForgejoCli.ForgejoCliError({
                command: "fj",
                cwd: "/w",
                reason: resolution === "org" ? "not-found" : "rate-limit",
                detail: "Native label lookup failed.",
              });
            return {
              stdout: encode({
                id: 93,
                name: resolution === "repo" ? name.toLowerCase() : "foreign",
              }),
            };
          });
          const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
          const result = yield* Effect.result(
            operation === "create"
              ? api.create!({ ...target, title: "New", body: "", labels: [name], assignees: [] })
              : api.update!({ ...target, title: "Changed", labels: [name] }),
          );
          const writes = requests.filter((request) => request.method);
          if (resolution === "repo" || resolution === "org") {
            expect(Result.isSuccess(result)).toBe(true);
            expect(writes.at(-1)?.body).toMatchObject({
              labels: [resolution === "repo" ? 93 : 99],
            });
          } else {
            expect(result).toMatchObject({
              failure: { reason: resolution === "rate-limit" ? "rate-limited" : "failed" },
            });
            expect(writes).toEqual([]);
          }
          expect(requests.length).toBeLessThanOrEqual(operation === "create" ? 17 : 19);
          expect(requests.some((request) => request.path.includes("page=4"))).toBe(false);
          expect(requests.filter((request) => /\/labels\/[^/?]+$/.test(request.path))).toHaveLength(
            resolution === "numeric" ? 0 : 1,
          );
        }
      }),
  );

  it.effect.each(["rate-limit", "wrong-label", "invalid-id"] as const)(
    "refuses native label fallback %s before any fields change",
    (failure) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.path === "repos/acme/web/issues/42") return { stdout: encode(ISSUE) };
          if (input.path.split("?")[0]!.endsWith("/labels"))
            return {
              stdout: encode([
                failure === "invalid-id" ? { id: 0, name: "later" } : { id: 3, name: "bug" },
              ]),
              stderr: 'Link: <https://forgejo.test/labels?page=2>; rel="next"',
            };
          if (failure === "rate-limit")
            return new ForgejoCli.ForgejoCliError({
              command: "fj",
              cwd: "/w",
              reason: "rate-limit",
              detail: "Native quota reached.",
            });
          return { stdout: encode({ id: 99, name: "different-label" }) };
        });
        const error = yield* Effect.flip(
          api.update!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
            title: "Changed",
            labels: ["later"],
          }),
        );
        expect(error.reason).toBe(failure === "rate-limit" ? "rate-limited" : "failed");
        expect(requests).toHaveLength(failure === "invalid-id" ? 2 : 8);
        expect(requests.filter((request) => request.method)).toEqual([]);
      }),
  );

  it.effect.each(
    (
      [
        { operation: "create", mode: "large-catalog", count: 5 },
        { operation: "create", mode: "lookup-limit", count: 17 },
        { operation: "create", mode: "over-budget", count: 6 },
        { operation: "update", mode: "large-catalog", count: 7 },
        { operation: "update", mode: "lookup-limit", count: 19 },
        { operation: "update", mode: "over-budget", count: 7 },
      ] as const
    ).flatMap((test) => [false, true].map((asIds) => ({ ...test, asIds }))),
  )(
    "bounds native label requests for $operation with $mode (IDs=$asIds)",
    ({ operation, mode, count, asIds }) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const names = Array.from(
          { length: mode === "lookup-limit" ? 5 : 121 },
          (_, index) => `${mode === "large-catalog" ? "KNOWN" : "LATER"}-${index}`,
        );
        const native = names.map((name, index) => ({ id: index + 1001, name: name.toLowerCase() }));
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method) return { stdout: encode(ISSUE) };
          if (input.path === "repos/acme/web/issues/42") return { stdout: encode(ISSUE) };
          const [route, query] = input.path.split("?");
          if (route!.endsWith("/labels")) {
            const page = Number(new URLSearchParams(query).get("page") ?? "1");
            return {
              stdout: encode(
                mode === "large-catalog" && route!.startsWith("repos/")
                  ? native.slice((page - 1) * 50, page * 50)
                  : Array.from({ length: 50 }, (_, index) => ({
                      id: index + 501,
                      name: `other-${index}`,
                    })),
              ),
              stderr: `Link: <https://forgejo.test/labels?page=${page + 1}>; rel="next"`,
            };
          }
          if (mode === "lookup-limit" && route!.startsWith("orgs/"))
            return {
              stdout: encode(
                native.find((label) =>
                  route!.endsWith(`/${asIds ? label.id : label.name.toUpperCase()}`),
                ),
              ),
            };
          return new ForgejoCli.ForgejoCliError({
            command: "fj",
            cwd: "/w",
            reason: "not-found",
            detail: "No scoped label.",
          });
        });
        const result = yield* Effect.result(
          operation === "create"
            ? api.create!({
                cwd: "/w",
                host: "forgejo.test:3000",
                scope: "acme/web",
                title: "New",
                body: "",
                labels: asIds ? native.map((label) => `forgejo-label:${label.id}`) : names,
                assignees: [],
              })
            : api.update!({
                cwd: "/w",
                host: "forgejo.test:3000",
                scope: "acme/web",
                key: "42",
                title: "Changed title",
                labels: asIds ? native.map((label) => `forgejo-label:${label.id}`) : names,
              }),
        );
        expect(Result.isSuccess(result)).toBe(mode !== "over-budget");
        expect(requests).toHaveLength(count);
        expect(requests.some((request) => request.path.includes("page=4"))).toBe(false);
        const writes = requests.filter((request) => request.method);
        if (mode === "over-budget") {
          expect(writes).toEqual([]);
          expect(requests.filter((request) => /\/labels\/[^/?]+$/.test(request.path))).toEqual([]);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              _tag: "IssueTrackerError",
              detail: expect.stringContaining("At most five"),
            });
        } else
          expect(writes.at(-1)?.body).toMatchObject({ labels: native.map((label) => label.id) });
      }),
  );

  it.effect.each([
    { source: "repo", name: "later-label" },
    { source: "org", name: "later-label" },
    { source: "repo", name: "12" },
    { source: "org", name: "12" },
  ] as const)(
    "resolves selectable page-two $source label $name for create and update",
    ({ source, name }) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const later = { id: 93, name };
        const first = Array.from({ length: 50 }, (_, index) => ({
          id: index + 1,
          name: `label-${index + 1}`,
        }));
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method) return { stdout: encode({ ...ISSUE, labels: [later], assignees: [] }) };
          if (input.path === "repos/acme/web/issues/42") return { stdout: encode(ISSUE) };
          const [route, query] = input.path.split("?");
          const org = route!.startsWith("orgs/");
          if (route!.endsWith("/labels")) {
            const page = Number(new URLSearchParams(query).get("page") ?? "1");
            const rows =
              org && source !== "org"
                ? []
                : page === 1
                  ? first
                  : (org ? "org" : "repo") === source && page === 2
                    ? [later]
                    : [];
            return {
              stdout: encode(rows),
              stderr: `Link: <https://forgejo.test/labels?page=${page === 1 && rows.length ? 2 : page}>; rel="${page === 1 && rows.length ? "next" : "last"}"`,
            };
          }
          return new ForgejoCli.ForgejoCliError({
            command: "fj",
            cwd: "/w",
            reason: "not-found",
            detail: "No such scoped label.",
          });
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        expect(
          (yield* api.listLabelCandidates!({ ...target, cursor: `${source}:2` })).items,
        ).toMatchObject([{ name }]);
        for (const operation of ["create", "update"] as const) {
          requests.length = 0;
          if (operation === "create")
            yield* api.create!({
              ...target,
              title: "New",
              body: "",
              labels: [name],
              assignees: [],
            });
          else yield* api.update!({ ...target, labels: [name] });
          expect(requests.filter((request) => request.method)).toMatchObject([
            { body: { labels: [93] } },
          ]);
          expect(requests.length).toBe(
            (source === "repo" ? 4 : 5) + (operation === "update" ? 1 : 0),
          );
          expect(requests.some((request) => request.path.includes("page=3"))).toBe(false);
          if (name === "12")
            expect(requests.some((request) => request.path.endsWith("/labels/12"))).toBe(false);
        }
      }),
  );

  it.effect("keeps native closing links without guessing the install on later pages", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode(
            input.path.includes("timeline")
              ? [
                  {
                    id: 1,
                    type: "pull_ref",
                    ref_action: "closes",
                    created_at: "2026-07-01T00:00:00Z",
                    ref_issue: {
                      number: 50,
                      html_url: "https://forgejo.test:3000/mount/acme/other/pulls/50",
                      pull_request: { merged: false },
                    },
                  },
                ]
              : {
                  number: 50,
                  title: "Fix",
                  html_url: "https://forgejo.test:3000/mount/acme/other/pulls/50",
                  state: "open",
                  merged: false,
                },
          ),
        };
      });
      expect(
        yield* api.getLinkedPullRequests!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "mount/acme/web",
          key: "42",
          limit: 1,
        }),
      ).toMatchObject({
        items: [
          {
            repository: "mount/acme/other",
            closesIssue: true,
            state: null,
            url: "https://forgejo.test:3000/mount/acme/other/pulls/50",
          },
        ],
      });
      expect(paths).toEqual(["repos/mount/acme/web/issues/42/timeline?limit=1&page=1"]);
    }),
  );

  it.effect.each([false, true])(
    "preserves a contact-only filing route with blank issues %s",
    (blankIssuesEnabled) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return {
            stdout: encode(
              input.path.endsWith("issue_config")
                ? { blank_issues_enabled: blankIssuesEnabled, contact_links: [CONTACT_LINK] }
                : [],
            ),
          };
        });
        expect(
          yield* api.listTemplates!({ cwd: "/w", host: "forgejo.test:3000", scope: "acme/web" }),
        ).toEqual({
          templates: [],
          blankIssuesEnabled,
          contactLinks: [CONTACT_LINK],
        });
        expect(requests.map((request) => request.path).sort()).toEqual([
          "repos/acme/web/issue_config",
          "repos/acme/web/issue_templates",
        ]);
        expect(requests.every((request) => request.method === undefined)).toBe(true);
      }),
  );

  it.effect.each([
    {
      name: "numeric input",
      body: [{ type: "input", attributes: { label: "Ticket" }, validations: { is_number: true } }],
    },
    {
      name: "regex input",
      body: [
        { type: "input", attributes: { label: "Ticket" }, validations: { regex: "^[0-9]+$" } },
      ],
    },
    {
      name: "unknown validation",
      body: [
        { type: "input", attributes: { label: "Ticket" }, validations: { custom_rule: true } },
      ],
    },
    {
      name: "content-only markdown",
      body: [
        {
          type: "markdown",
          visible: ["content"],
          attributes: { value: "Required incident notice" },
        },
      ],
    },
    {
      name: "form-only input",
      body: [{ type: "input", visible: ["form"], attributes: { label: "Ticket" } }],
    },
    {
      name: "content-only checkbox option",
      body: [
        {
          type: "checkboxes",
          attributes: {
            label: "Agree",
            options: [{ label: "Required notice", visible: ["content"] }],
          },
        },
      ],
    },
    { name: "unknown field", body: [{ type: "date", attributes: { label: "When" } }] },
    { name: "unknown body shape", body: { fields: [] } },
    { name: "empty form", body: [] },
  ])("keeps $name reachable through the native form", ({ body }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const filename = ".forgejo/ISSUE_TEMPLATE/incident #1&title=other.yaml";
      const api = yield* tracker((input) => {
        requests.push(input);
        return {
          repositoryUrl: "https://forgejo.test:3000/mount/acme/web",
          stdout: encode(
            input.path.endsWith("issue_config")
              ? { blank_issues_enabled: false, contact_links: [CONTACT_LINK] }
              : [
                  { file_name: filename, name: "Incident", about: "Report an incident", body },
                  { file_name: "bug.md", name: "Bug", content: "Describe the bug" },
                ],
          ),
        };
      });
      const result = yield* api.listTemplates!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "mount/acme/web",
      });
      expect(result).toMatchObject({
        templates: [{ key: "bug.md", body: "Describe the bug" }],
        externalTemplates: [{ name: "Incident", about: "Report an incident" }],
        blankIssuesEnabled: false,
        contactLinks: [CONTACT_LINK],
      });
      expect(result.templates).toHaveLength(1);
      expect(result.externalTemplates).toHaveLength(1);
      const url = new URL(result.externalTemplates![0]!.url);
      expect(url.origin).toBe("https://forgejo.test:3000");
      expect(url.pathname).toBe("/mount/acme/web/issues/new");
      expect([...url.searchParams]).toEqual([["template", filename]]);
      expect(url.hash).toBe("");
      expect(requests.map((request) => request.path).sort()).toEqual([
        "repos/mount/acme/web/issue_config",
        "repos/mount/acme/web/issue_templates",
      ]);
      expect(requests.every((request) => request.method === undefined)).toBe(true);
    }),
  );

  it.effect("refuses a native form destination without a resolved repository URL", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode(
            input.path.endsWith("issue_config")
              ? { blank_issues_enabled: false }
              : [
                  {
                    file_name: ".forgejo/ISSUE_TEMPLATE/incident.yaml",
                    body: [{ type: "unknown" }],
                  },
                ],
          ),
        };
      });
      const error = yield* Effect.flip(
        api.listTemplates!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
        }),
      );
      expect(error).toMatchObject({
        reason: "failed",
        detail: expect.stringContaining("repository URL"),
      });
      expect(paths.sort()).toEqual([
        "repos/acme/web/issue_config",
        "repos/acme/web/issue_templates",
      ]);
    }),
  );

  it.effect("preserves native structured form fields with contact links", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => ({
        stdout: encode(
          input.path.endsWith("issue_config")
            ? { blank_issues_enabled: false, contact_links: [CONTACT_LINK] }
            : [
                {
                  file_name: "bug.yml",
                  name: "Bug",
                  body: [
                    {
                      type: "markdown",
                      attributes: { value: "Read first" },
                      validations: null,
                      visible: ["form"],
                    },
                    {
                      type: "textarea",
                      id: "repro",
                      attributes: { label: "Steps", render: "shell" },
                      validations: { required: true, is_number: false, regex: "" },
                      visible: ["form", "content"],
                    },
                    {
                      type: "dropdown",
                      id: "version",
                      attributes: {
                        label: "Version",
                        options: ["Stable", "Preview"],
                        multiple: true,
                      },
                    },
                    {
                      type: "checkboxes",
                      id: "agree",
                      attributes: {
                        label: "Agree",
                        options: [
                          { label: "Checked", required: true, visible: ["form", "content"] },
                        ],
                      },
                    },
                  ],
                },
              ],
        ),
      }));
      expect(
        yield* api.listTemplates!({ cwd: "/w", host: "forgejo.test:3000", scope: "acme/web" }),
      ).toMatchObject({
        blankIssuesEnabled: false,
        contactLinks: [CONTACT_LINK],
        templates: [
          {
            key: "bug.yml",
            fields: [
              { kind: "markdown", value: "Read first" },
              { kind: "textarea", id: "repro", required: true, render: "shell" },
              { kind: "dropdown", multiple: true, options: ["Stable", "Preview"] },
              { kind: "checkboxes", options: [{ label: "Checked", required: true }] },
            ],
          },
        ],
      });
    }),
  );

  it.effect.each([
    { blank_issues_enabled: false },
    { blank_issues_enabled: false, contact_links: null },
    { blank_issues_enabled: false, contact_links: [] },
  ])("keeps the native blank issue setting without contacts: %s", (config) =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => ({
        stdout: encode(input.path.endsWith("issue_config") ? config : []),
      }));
      expect(
        yield* api.listTemplates!({ cwd: "/w", host: "forgejo.test:3000", scope: "acme/web" }),
      ).toEqual({
        templates: [],
        blankIssuesEnabled: false,
      });
    }),
  );

  it.effect.each([
    { blank_issues_enabled: "false" },
    { blank_issues_enabled: false, contact_links: [{ name: "Support", url: 1 }] },
    { blank_issues_enabled: false, contact_links: Array.from({ length: 101 }, () => CONTACT_LINK) },
  ])("preserves the fallback for invalid native issue config: %s", (config) =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => ({
        stdout: encode(input.path.endsWith("issue_config") ? config : []),
      }));
      expect(
        yield* api.listTemplates!({ cwd: "/w", host: "forgejo.test:3000", scope: "acme/web" }),
      ).toEqual({
        templates: [],
        blankIssuesEnabled: true,
      });
    }),
  );

  it.effect("returns safe contact URLs within the shared collection limit", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => ({
        stdout: encode(
          input.path.endsWith("issue_config")
            ? {
                blank_issues_enabled: false,
                contact_links: [
                  ...Array.from({ length: 96 }, () => CONTACT_LINK),
                  { ...CONTACT_LINK, url: "http://support.example.test/help" },
                  { ...CONTACT_LINK, url: "javascript:alert(1)" },
                  { ...CONTACT_LINK, url: "data:text/html,hello" },
                  { ...CONTACT_LINK, url: "/relative" },
                ],
              }
            : [],
        ),
      }));
      const result = yield* api.listTemplates!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
      });
      expect(result.blankIssuesEnabled).toBe(false);
      expect(result.contactLinks).toHaveLength(97);
      expect(result.contactLinks?.at(-1)?.url).toBe("http://support.example.test/help");
    }),
  );

  it.effect.each(["not-found", "invalid-response", "authentication", "rate-limit"] as const)(
    "preserves native issue config %s failures",
    (reason) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return input.path.endsWith("issue_config")
            ? new ForgejoCli.ForgejoCliError({
                command: "fj",
                cwd: "/w",
                reason,
                detail: "Native config failure.",
              })
            : { stdout: "[]" };
        });
        const result = yield* Effect.result(
          api.listTemplates!({ cwd: "/w", host: "forgejo.test:3000", scope: "acme/web" }),
        );
        if (reason === "authentication" || reason === "rate-limit")
          expect(result).toMatchObject({
            failure: { reason: reason === "authentication" ? "unauthenticated" : "rate-limited" },
          });
        else expect(result).toMatchObject({ success: { templates: [], blankIssuesEnabled: true } });
        expect(requests).toHaveLength(2);
        expect(requests.every((request) => request.method === undefined)).toBe(true);
      }),
  );

  it.effect.each(["done", "CLOSED", "Open", " closed ", "open", "closed"])(
    "accepts only exact native state names: %s",
    (state) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return { stdout: "{}" };
        });
        const result = yield* Effect.result(
          api.setState!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "Mount/acme/web",
            key: "42",
            state,
          }),
        );
        const supported = state === "open" || state === "closed";
        expect(Result.isSuccess(result)).toBe(supported);
        if (supported)
          expect(requests).toMatchObject([
            { path: "repos/Mount/acme/web/issues/42", method: "PATCH", body: { state } },
          ]);
        else
          expect(result).toMatchObject({
            failure: { _tag: "IssueTrackerError", operation: "setState", reason: "failed" },
          });
        expect(requests).toHaveLength(supported ? 1 : 0);
      }),
  );

  it.effect.each([
    { name: "populated", milestone: { title: "Release 1" } },
    { name: "null", milestone: null },
    { name: "absent", milestone: undefined },
  ])("keeps the $name native milestone in list and detail", ({ milestone }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const native = { ...ISSUE, milestone };
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.path.startsWith("repos/acme/web/issues?"))
          return { stdout: encode([native]), stderr: 'Link: </last>; rel="last"' };
        if (input.path === "repos/acme/web/issues/42") return { stdout: encode(native) };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      expect(
        (yield* api.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          viewer: "julius",
          limit: 50,
        })).items[0],
      ).toHaveProperty("milestone", milestone?.title ?? null);
      expect(requests).toHaveLength(1);
      expect(yield* api.getIssue(target)).toHaveProperty("milestone", milestone?.title ?? null);
      expect(requests).toHaveLength(9);
      expect(requests.every((request) => request.method === undefined)).toBe(true);
      expect(requests.some((request) => request.path.includes("milestone"))).toBe(false);
    }),
  );

  it.effect.each([
    { path: "/Acme/Web/issues/42", allowed: true },
    { path: "/api/v1/repos/Acme/Web/issues/42", allowed: true },
    { path: "/Mount/Acme/Web/issues/42", mount: "Mount/", allowed: true },
    { path: "/Mount/api/v1/repos/Acme/Web/issues/42", mount: "Mount/", allowed: true },
    { path: "/Acme/Web/issues/42", host: "other.test:3000", allowed: false },
    { path: "/Acme/Web/issues/42", host: "forgejo.test:3001", allowed: false },
    { path: "/Acme/Other/issues/42", allowed: false },
    { path: "/Other/Web/issues/42", allowed: false },
    { path: "/Acme/Web/issues/41", allowed: false },
    { path: "/Acme/Web/issues/42", id: 8, allowed: false },
    { path: "/other/Acme/Web/issues/42", mount: "Mount/", allowed: false },
    { path: "/mount/Acme/Web/issues/42", mount: "Mount/", allowed: false },
    { path: "/Mount/api/v1/Repos/Acme/Web/issues/42", mount: "Mount/", allowed: false },
    { path: "/Acme/Web/Issues/42", allowed: false },
  ])(
    "checks canonical comment membership for $path",
    ({ path, host = "forgejo.test:3000", mount = "", id = 7, allowed }) =>
      Effect.gen(function* () {
        for (const operation of ["edit", "react", "unreact"] as const) {
          const requests: ForgejoCli.ForgejoApiInput[] = [];
          const api = yield* tracker((input) => {
            requests.push(input);
            return { stdout: encode({ id, issue_url: `https://${host}${path}` }) };
          });
          const target = {
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: `${mount}acme/web`,
            key: "42",
          };
          const result = yield* Effect.result(
            operation === "edit"
              ? api.editComment!({ ...target, commentId: "7", body: "Updated" })
              : api.setReaction!({
                  ...target,
                  subjectId: "7",
                  content: "thumbs-up",
                  reacted: operation === "react",
                }),
          );
          expect(Result.isSuccess(result)).toBe(allowed);
          expect(requests).toHaveLength(allowed ? 2 : 1);
          expect(requests[0]).toMatchObject({ path: `repos/${target.scope}/issues/comments/7` });
          expect(requests[0]?.method).toBeUndefined();
          if (allowed)
            expect(requests[1]?.method).toBe(
              operation === "edit" ? "PATCH" : operation === "react" ? "POST" : "DELETE",
            );
          else expect(requests.every((request) => request.method === undefined)).toBe(true);
        }
      }),
  );

  it.effect.each(["42", "99"])("edits a comment only when its native issue URL names %s", (key) =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        if (input.method) {
          writes.push(input);
          return { stdout: "{}" };
        }
        return {
          stdout: encode({
            id: 7,
            issue_url: `https://forgejo.test:3000/api/v1/repos/acme/web/issues/${key}`,
          }),
        };
      });
      const result = yield* Effect.result(
        api.editComment!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
          commentId: "7",
          body: "Updated",
        }),
      );
      expect(Result.isSuccess(result)).toBe(key === "42");
      expect(writes).toEqual(
        key === "42"
          ? [
              {
                cwd: "/w",
                host: "forgejo.test:3000",
                repository: "acme/web",
                path: "repos/acme/web/issues/comments/7",
                method: "PATCH",
                body: { body: "Updated" },
              },
            ]
          : [],
      );
    }),
  );

  it.effect("pages history and organization labels without dropping native continuation", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return input.path.includes("timeline")
          ? {
              stdout: encode([
                { id: 1, type: "milestone", created_at: "2026-07-01T00:00:00Z", body: "Release" },
              ]),
              stderr: 'link: <https://forgejo.test/next>; rel="next"',
            }
          : {
              stdout: encode([{ id: 1, name: "bug", color: "aabbcc" }]),
              stderr: 'link: <https://forgejo.test/last>; rel="last"',
            };
      });
      const target = {
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        limit: 1,
      };
      const history = yield* api.getHistory!({ ...target, order: "asc" });
      expect(history.items).toMatchObject([{ kind: "updated", detail: "Release" }]);
      expect(history.nextCursor).toBeTruthy();
      const repo = yield* api.listLabelCandidates!(target);
      expect(repo.nextCursor).toBe("org:1");
      expect(
        yield* api.listLabelCandidates!({ ...target, cursor: repo.nextCursor! }),
      ).toMatchObject({ items: [{ name: "bug" }], nextCursor: null });
      expect(paths).toContain("orgs/acme/labels?limit=1&page=1");
    }),
  );

  it.effect.each([undefined, "julius", "maintainer"])(
    "does not fetch a viewer just to show older comment edit flags %s",
    (viewer) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          return answer(input.path);
        });
        const page = yield* api.getComments({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
          order: "asc",
          ...(viewer === undefined ? {} : { viewer }),
        });
        if (viewer === "julius") expect(page.comments[0]?.canEdit).toBe(true);
        else expect(page.comments[0]).not.toHaveProperty("canEdit");
        expect(paths).not.toContain("user");
        expect(paths).not.toContain("repos/acme/web");
      }),
  );

  it.effect.each([
    { reacted: true, method: "POST", issueUrl: "https://forgejo.test:3000/acme/web/issues/42" },
    {
      reacted: false,
      method: "DELETE",
      issueUrl: "https://forgejo.test:3000/api/v1/repos/acme/web/issues/42",
    },
    {
      reacted: true,
      method: "POST",
      issueUrl: "https://forgejo.test:3000/forgejo/acme/web/issues/42",
    },
    {
      reacted: true,
      method: "POST",
      scope: "forgejo/maria/project",
      issueUrl: "https://forgejo.test:3000/forgejo/maria/project/issues/42",
    },
    {
      reacted: false,
      method: "DELETE",
      scope: "forgejo/maria/project",
      issueUrl: "https://forgejo.test:3000/forgejo/api/v1/repos/maria/project/issues/42",
    },
  ])(
    "checks comment ownership before $method reaction",
    ({ reacted, method, issueUrl, scope = "acme/web" }) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return {
            stdout: encode({ id: 7, issue_url: issueUrl }),
          };
        });
        yield* api.setReaction!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope,
          key: "42",
          subjectId: "7",
          content: "thumbs-up",
          reacted,
        });
        expect(requests).toMatchObject([
          { path: `repos/${scope}/issues/comments/7` },
          { path: `repos/${scope}/issues/comments/7/reactions`, method, body: { content: "+1" } },
        ]);
        expect(requests[0]?.method).toBeUndefined();
      }),
  );

  it.effect.each([
    { issue_url: "https://forgejo.test:3000/acme/web/issues/41" },
    { issue_url: "https://forgejo.test:3000/acme/other/issues/42" },
    { issue_url: "https://other.test:3000/acme/web/issues/42" },
    { issue_url: "https://forgejo.test/acme/web/issues/42" },
    { issue_url: "https://forgejo.test:3000/acme/web/pulls/42" },
    { issue_url: "not a URL" },
    { issue_url: "" },
    {},
    { id: 8, issue_url: "https://forgejo.test:3000/acme/web/issues/42" },
    { issue_url: "https://forgejo.test:3000/acme/web/issues/42", stdoutTruncated: true },
  ])("refuses comment reactions when native ownership is wrong or unknown: %s", (ownership) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return {
          stdout: encode({ id: 7, ...ownership }),
          stdoutTruncated: "stdoutTruncated" in ownership && ownership.stdoutTruncated,
        };
      });
      for (const reacted of [true, false]) {
        yield* Effect.flip(
          api.setReaction!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
            subjectId: "7",
            content: "thumbs-up",
            reacted,
          }),
        );
      }
      expect(requests.map((input) => input.path)).toEqual([
        "repos/acme/web/issues/comments/7",
        "repos/acme/web/issues/comments/7",
      ]);
      expect(requests.every((input) => input.method === undefined)).toBe(true);
    }),
  );

  it.effect.each([true, false])("keeps whole-issue reactions at one write: reacted=%s", (reacted) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return { stdout: "{}" };
      });
      yield* api.setReaction!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        content: "thumbs-up",
        reacted,
      });
      expect(requests).toMatchObject([
        {
          path: "repos/acme/web/issues/42/reactions",
          method: reacted ? "POST" : "DELETE",
          body: { content: "+1" },
        },
      ]);
    }),
  );

  it.effect("joins the issue, timeline and conversation into the neutral issue shape", () =>
    Effect.gen(function* () {
      const hosts = new Set<string | undefined>();
      const api = yield* tracker((input) => {
        hosts.add(input.host);
        return answer(input.path);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      // The custom host and port reach the CLI, which resolves the login for them.
      expect([...hosts]).toEqual(["forgejo.test:3000"]);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        state: { category: "open", name: "open" },
        author: { login: "octocat", name: "Octo Cat", avatarUrl: null },
        createdAt: "2026-06-30T22:00:00.000Z",
        labels: [{ name: "bug", color: "d73a4a" }],
        viewer: "julius",
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: true,
        },
        reactions: [{ content: "eyes", count: 1, actors: ["theo"], viewerHasReacted: false }],
        reactionsTruncated: true,
        commentsCursor: expect.any(String),
      });
      expect(issue.comments).toEqual([
        {
          id: "7",
          author: { login: "julius", name: null, avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00.000Z",
          editedAt: null,
          canEdit: true,
          url: "https://forgejo.test:3000/acme/web/issues/42#issuecomment-7",
          reactions: [{ content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true }],
        },
      ]);
      // Comments and milestones on the timeline are not events in the shared vocabulary.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "#50"],
      ]);
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://forgejo.test:3000/acme/web/pulls/50",
          state: "open",
          isDraft: true,
          closesIssue: false,
        },
      ]);
    }),
  );

  it.effect.each([false, true])(
    "marks native issue reaction page partial only when needed: %s",
    (partial) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (input.path.startsWith("repos/acme/web/issues/42/reactions"))
            return {
              stdout: encode(
                partial
                  ? Array.from({ length: 50 }, (_, index) => ({
                      content: "eyes",
                      user: { login: `user${index}` },
                    }))
                  : [{ content: "eyes", user: { login: "julius" } }],
              ),
              stderr: partial
                ? 'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/reactions?page=2>; rel="next"'
                : 'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/reactions?page=1>; rel="last"',
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(issue.reactionsTruncated).toBe(partial);
        expect(issue.reactions).toMatchObject([
          { content: "eyes", count: partial ? 50 : 1, viewerHasReacted: !partial },
        ]);
        expect(
          paths.filter((path) => path.startsWith("repos/acme/web/issues/42/reactions")),
        ).toEqual(["repos/acme/web/issues/42/reactions?limit=50&page=1"]);
      }),
  );

  it.effect("keeps unknown issue-unit controls available without using code push permission", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => answer(input.path));
      expect(
        yield* api.getViewerPermissions({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        }),
      ).toEqual({ setState: true, comment: true, edit: true, labels: true, assignees: true });
    }),
  );

  it.effect("reads only the repository to determine issue permissions", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return answer(input.path);
      });
      yield* api.getViewerPermissions({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      expect(paths).toEqual(["repos/acme/web"]);
    }),
  );

  it.effect.each([
    { name: "a non-admin issue writer with code read access", denied: false },
    { name: "a reader refused by native issue permissions", denied: true },
  ])("lets the native API decide locked commenting for $name", ({ denied }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const detail = "Native issue permissions denied this comment.";
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.method === "POST")
          return denied
            ? new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: "/w",
                reason: "forbidden",
                httpStatus: 403,
                detail,
              })
            : {
                stdout: encode({
                  id: 8,
                  body: "A comment",
                  user: { login: "julius" },
                  created_at: "2026-07-04T00:00:00Z",
                }),
                stderr: "HTTP/1.1 201 Created",
              };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      expect((yield* api.getViewerPermissions(target)).comment).toBe(true);
      const write = api.comment!({ ...target, body: "A comment" });
      if (denied) expect(yield* Effect.flip(write)).toMatchObject({ reason: "failed", detail });
      else yield* write;
      expect(requests).toHaveLength(2);
      expect(requests.filter((request) => request.method === "POST")).toEqual([
        {
          cwd: "/w",
          host: "forgejo.test:3000",
          repository: "acme/web",
          path: "repos/acme/web/issues/42/comments",
          method: "POST",
          body: { body: "A comment" },
        },
      ]);
    }),
  );

  it.effect.each([{ archived: true }, { has_issues: false }])(
    "disables issue controls for native repository restriction %s",
    (restriction) =>
      Effect.gen(function* () {
        const api = yield* tracker((input) =>
          input.path === "repos/acme/web"
            ? {
                stdout: encode({
                  full_name: "acme/web",
                  permissions: { push: true, admin: false },
                  ...restriction,
                }),
              }
            : answer(input.path),
        );
        expect(
          yield* api.getViewerPermissions({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
          }),
        ).toEqual({
          setState: false,
          comment: false,
          edit: false,
          labels: false,
          assignees: false,
        });
      }),
  );

  it.effect(
    "resolves linked pull requests by native repository and number on the configured host",
    () =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const references = [
          ["acme/web", 50],
          ["other/repo", 50],
          ["other/repo", 50],
          ["foreign/repo", 60],
        ] as const;
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const route = input.path.split("?")[0]!;
          if (route === "repos/acme/web/issues/42/timeline")
            return {
              stdout: encode(
                references.map(([repository, number], index) => ({
                  id: index + 1,
                  type: "pull_ref",
                  created_at: "2026-07-02T00:00:00Z",
                  ref_issue: {
                    number,
                    html_url: `https://${repository === "foreign/repo" ? "other.test" : "forgejo.test:3000"}/${repository}/pulls/${number}`,
                    pull_request: { merged: false },
                  },
                })),
              ),
            };
          if (route === "repos/other/repo/pulls/50")
            return {
              stdout: encode({
                number: 50,
                title: "Other project fix",
                html_url: "https://forgejo.test:3000/other/repo/pulls/50",
                state: "closed",
                merged: true,
              }),
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(
          issue.linkedPullRequests.map((pull) => [pull.repository, pull.number, pull.state]),
        ).toEqual([
          ["acme/web", 50, "open"],
          ["other/repo", 50, "merged"],
        ]);
        expect(paths.filter((path) => path.includes("/pulls/"))).toEqual([
          "repos/acme/web/pulls/50",
          "repos/other/repo/pulls/50",
        ]);
      }),
  );

  it.effect.each(["mount-a/acme/web", "acme/web"])(
    "keeps linked pull request installation identity for scope %s",
    (scope) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const urls = [
          "https://forgejo.test:3000/mount-a/acme/web/pulls/50",
          "https://forgejo.test:3000/mount-b/acme/web/pulls/50",
          "https://forgejo.test:3000/mount-a/other/repo/pulls/50",
          "https://forgejo.test:3000/mount-b/other/repo/pulls/50",
        ];
        const api = yield* tracker((input) => {
          requests.push(input);
          const route = input.path.split("?")[0]!;
          if (route === `repos/${scope}/issues/42`)
            return {
              stdout: encode({
                ...ISSUE,
                html_url: "https://forgejo.test:3000/mount-a/acme/web/issues/42",
              }),
            };
          if (route === `repos/${scope}/issues/42/timeline`)
            return {
              stdout: encode(
                [
                  ...urls,
                  urls[1]!,
                  "https://other.test/mount-a/acme/web/pulls/50",
                  "invalid",
                  "https://forgejo.test:3000/mount-a/acme/web/pulls/51",
                ].map((url, index) => ({
                  id: index + 1,
                  type: "pull_ref",
                  created_at: "2026-07-02T00:00:00Z",
                  ref_issue: { number: 50, html_url: url, pull_request: { merged: false } },
                })),
              ),
            };
          if (route.includes("/pulls/")) {
            const other = route.includes("other/repo");
            return {
              stdout: encode({
                number: 50,
                title: other ? "Other A fix" : "A fix",
                html_url: urls[other ? 2 : 0],
                state: "closed",
                merged: true,
              }),
            };
          }
          return answer(input.path.replace(`repos/${scope}`, "repos/acme/web"));
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope,
          key: "42",
        });
        expect(issue.linkedPullRequests).toMatchObject([
          {
            repository: "mount-a/acme/web",
            number: 50,
            title: "A fix",
            url: urls[0],
            state: "merged",
          },
          {
            repository: "mount-b/acme/web",
            number: 50,
            title: "#50",
            url: urls[1],
            state: null,
            isDraft: false,
          },
          {
            repository: "mount-a/other/repo",
            number: 50,
            title: "Other A fix",
            url: urls[2],
            state: "merged",
          },
          {
            repository: "mount-b/other/repo",
            number: 50,
            title: "#50",
            url: urls[3],
            state: null,
            isDraft: false,
          },
        ]);
        expect(requests.filter((request) => request.path.includes("/pulls/"))).toEqual([
          {
            cwd: "/w",
            host: "forgejo.test:3000",
            repository: "mount-a/acme/web",
            path: "repos/mount-a/acme/web/pulls/50",
          },
          {
            cwd: "/w",
            host: "forgejo.test:3000",
            repository: "mount-a/other/repo",
            path: "repos/mount-a/other/repo/pulls/50",
          },
        ]);
        expect(requests).toHaveLength(9);
        expect(
          requests.filter((request) => request.path === `repos/${scope}/issues/42`),
        ).toHaveLength(1);
        requests.length = 0;
        const page = yield* api.getLinkedPullRequests!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope,
          key: "42",
        });
        expect(page.items).toMatchObject([
          { repository: "mount-a/acme/web", url: urls[0], state: null },
          { repository: "mount-b/acme/web", url: urls[1], state: null },
          { repository: "mount-a/other/repo", url: urls[2], state: null },
          { repository: "mount-b/other/repo", url: urls[3], state: null },
        ]);
        expect(requests).toMatchObject([
          { path: `repos/${scope}/issues/42/timeline?limit=50&page=1` },
        ]);
        expect(requests).toHaveLength(1);
      }),
  );

  it.effect("marks native timeline continuation without walking its next page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const result = answer(input.path);
        return input.path.includes("/timeline")
          ? {
              ...result,
              stderr:
                'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/timeline?page=2>; rel="next"',
            }
          : result;
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.historyTruncated).toBe(true);
      expect(paths.filter((path) => path.includes("/timeline"))).toHaveLength(1);
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "refuses unresolved label names before %s writes",
    (operation) =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (/\/labels\/[^/?]+$/.test(input.path))
            return new ForgejoCli.ForgejoCliError({
              command: "fj",
              cwd: "/w",
              reason: "not-found",
              detail: "No such scoped label.",
            });
          if (input.method) {
            writes.push(input.path);
            return { stdout: encode(ISSUE) };
          }
          if (
            input.path.startsWith("repos/acme/web/labels") ||
            input.path.startsWith("orgs/acme/labels")
          )
            return {
              stdout: encode([{ id: 12, name: "bug" }]),
              stderr: 'Link: <https://forgejo.test/labels?page=2>; rel="next"',
            };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const error = yield* Effect.flip(
          operation === "create"
            ? api.create!({
                ...target,
                title: "New issue",
                body: "",
                labels: ["12", "later"],
                assignees: [],
              })
            : api.update!({ ...target, title: "Changed title", labels: ["12", "later"] }),
        );
        expect(error.detail).toContain("label");
        expect(writes).toEqual([]);
        expect(paths).toHaveLength(operation === "create" ? 8 : 9);
        expect(paths.some((path) => path.includes("page=4"))).toBe(false);
      }),
  );

  it.effect.each([
    { labels: ["Old", "bug", "enhancement", "Old"], ids: [90, 3, 4] },
    { labels: ["bug", "enhancement"], ids: [3, 4] },
    { labels: ["forgejo-label:90", "forgejo-label:3", "forgejo-label:4"], ids: [90, 3, 4] },
    { labels: [], ids: [] },
  ])("replaces labels without losing retained organization labels: $labels", ({ labels, ids }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.method) return { stdout: "[]" };
        if (input.path.startsWith("repos/acme/web/labels"))
          return {
            stdout: encode([
              { id: 3, name: "bug" },
              { id: 4, name: "enhancement" },
            ]),
          };
        if (input.path === "repos/acme/web/issues/42")
          return {
            stdout: encode({ ...ISSUE, labels: [...ISSUE.labels, { id: 90, name: "Old" }] }),
          };
        throw new Error(`unexpected path ${input.path}`);
      });
      yield* api.update!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        labels,
      });
      expect(requests.filter((input) => input.method)).toMatchObject([
        { path: "repos/acme/web/issues/42/labels", method: "PUT", body: { labels: ids } },
      ]);
      expect(requests).toHaveLength(labels.length ? 3 : 1);
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "offers and resolves one native organization label page for %s",
    (operation) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method)
            return {
              stdout: encode({
                ...ISSUE,
                labels: [
                  { id: 3, name: "bug" },
                  { id: 91, name: "Org" },
                ],
              }),
            };
          if (input.path.startsWith("repos/acme/web/labels"))
            return {
              stdout: encode(ISSUE.labels),
              stderr: 'Link: <https://forgejo.test/labels?page=1>; rel="last"',
            };
          if (input.path.startsWith("orgs/acme/labels"))
            return {
              stdout: encode([
                { id: 91, name: "Org" },
                { id: 99, name: "bug", color: "ffffff" },
              ]),
              stderr: 'Link: <https://forgejo.test/labels?page=2>; rel="next"',
            };
          if (input.path.startsWith("repos/acme/web/assignees")) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        expect(yield* api.listCandidates!(target)).toMatchObject({
          labels: [
            { id: "forgejo-label:3", name: "bug", color: "d73a4a" },
            { id: "forgejo-label:91", name: "Org" },
            { id: "forgejo-label:99", name: "bug" },
          ],
          truncated: true,
        });
        expect(requests.map((input) => input.path)).toContain("orgs/acme/labels?limit=50&page=1");
        requests.length = 0;
        if (operation === "create")
          yield* api.create!({
            ...target,
            title: "New issue",
            body: "",
            labels: ["bug", "Org"],
            assignees: [],
          });
        else yield* api.update!({ ...target, labels: ["bug", "Org"] });
        expect(requests.filter((input) => input.method)).toMatchObject([
          { body: { labels: [3, 91] } },
        ]);
        expect(requests.filter((input) => input.path.startsWith("orgs/"))).toHaveLength(1);
        expect(requests).toHaveLength(operation === "create" ? 3 : 4);
      }),
  );

  it.effect.each(["not-found", "rate-limit"] as const)(
    "keeps repository candidates only for absent organization API, not %s failures",
    (reason) =>
      Effect.gen(function* () {
        const api = yield* tracker((input) => {
          if (input.path.startsWith("orgs/acme/labels"))
            return new ForgejoCli.ForgejoCliError({
              command: "tea",
              cwd: "/w",
              reason,
              detail: "Organization labels unavailable.",
            });
          if (input.path.startsWith("repos/acme/web/labels"))
            return { stdout: encode(ISSUE.labels) };
          if (input.path.startsWith("repos/acme/web/assignees")) return { stdout: "[]" };
          throw new Error(`unexpected path ${input.path}`);
        });
        const result = api.listCandidates!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
        });
        if (reason === "not-found")
          expect(yield* result).toMatchObject({ labels: [{ name: "bug" }], truncated: true });
        else expect(yield* Effect.flip(result)).toMatchObject({ reason: "rate-limited" });
      }),
  );

  it.effect.each(["create", "update"] as const)(
    "uses the native organization owner for mounted %s and candidates",
    (operation) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method)
            return { stdout: encode({ ...ISSUE, labels: [{ id: 91, name: "Org" }] }) };
          if (input.path.startsWith("orgs/maria/labels"))
            return { stdout: encode([{ id: 91, name: "Org" }]) };
          if (input.path === "repos/forgejo/maria/project/issues/42")
            return { stdout: encode(ISSUE) };
          if (
            input.path.startsWith("repos/forgejo/maria/project/labels") ||
            input.path.startsWith("repos/forgejo/maria/project/assignees")
          )
            return { stdout: "[]" };
          throw new Error(`unexpected path ${input.path}`);
        });
        const target = {
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "forgejo/maria/project",
          key: "42",
        };
        expect(yield* api.listCandidates!(target)).toMatchObject({ labels: [{ name: "Org" }] });
        requests.length = 0;
        if (operation === "create")
          yield* api.create!({ ...target, title: "New", body: "", labels: ["Org"], assignees: [] });
        else yield* api.update!({ ...target, labels: ["Org"] });
        expect(requests.filter((request) => request.path.startsWith("orgs/"))).toMatchObject([
          { path: "orgs/maria/labels?limit=50&page=1" },
        ]);
        expect(requests.filter((request) => request.method)).toMatchObject([
          { body: { labels: [91] } },
        ]);
        expect(requests).toHaveLength(operation === "create" ? 3 : 4);
      }),
  );

  it.effect.each([
    "https://forgejo.test:3000/forgejo/maria/other/issues/42",
    "https://forgejo.test:3000/forgejo/maria/project/issues/41",
    "https://other.test:3000/forgejo/maria/project/issues/42",
    "https://forgejo.test:3000/other/maria/project/issues/42",
    "https://forgejo.test:3000/other/api/v1/repos/maria/project/issues/42",
  ])("refuses mounted reaction owner mismatch: %s", (issue_url) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return { stdout: encode({ id: 7, issue_url }) };
      });
      yield* Effect.flip(
        api.setReaction!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "forgejo/maria/project",
          key: "42",
          subjectId: "7",
          content: "thumbs-up",
          reacted: true,
        }),
      );
      expect(requests).toMatchObject([{ path: "repos/forgejo/maria/project/issues/comments/7" }]);
      expect(requests[0]?.method).toBeUndefined();
    }),
  );

  it.effect.each([
    "repos/acme/web/labels?limit=50&page=1",
    "repos/acme/web/issues/42",
    "orgs/acme/labels?limit=50&page=1",
  ])("refuses truncated label resolution response at %s before changing any fields", (path) =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        if (input.method) writes.push(input);
        const response =
          input.path === "repos/acme/web/issues/42"
            ? { stdout: encode(ISSUE) }
            : { stdout: encode([{ id: 92, name: "Org" }]) };
        return input.path === path ? { ...response, stdoutTruncated: true } : response;
      });
      const error = yield* Effect.flip(
        api.update!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
          title: "Changed",
          labels: ["Old"],
        }),
      );
      expect(error.detail).toContain("output limit");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("maps a numeric native label name to its actual mutation ID", () =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        if (input.path.startsWith("repos/acme/web/labels"))
          return {
            stdout: encode([
              { id: 93, name: "12" },
              { id: 12, name: "bug" },
            ]),
          };
        if (input.method) {
          writes.push(input);
          return { stdout: encode(ISSUE) };
        }
        return answer(input.path);
      });
      yield* api.create!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        title: "New issue",
        body: "",
        labels: ["12"],
        assignees: [],
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toMatchObject({ labels: [93] });
    }),
  );

  it.effect.each([{ assignees: ["julius"] }, { assignees: [] }] as const)(
    "reports native success with ignored assignee set %s as a failed update",
    ({ assignees }) =>
      Effect.gen(function* () {
        const writes: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          writes.push(input);
          return { stdout: encode(ISSUE), stderr: "HTTP/1.1 201 Created" };
        });
        const error = yield* Effect.flip(
          api.update!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
            assignees,
          }),
        );
        expect(error.detail).toContain("assignees");
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ method: "PATCH", body: { assignees: [...assignees] } });
      }),
  );

  it.effect.each(["labels", "assignees"] as const)(
    "keeps the created issue and warns when native success skips selected %s",
    (field) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return input.method === "POST"
            ? {
                stdout: encode({ ...ISSUE, labels: [], assignees: [] }),
                stderr: "HTTP/1.1 201 Created",
              }
            : { stdout: encode([{ id: 3, name: "bug" }]) };
        });
        const result = yield* api.create!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          title: "New issue",
          body: "",
          labels: field === "labels" ? ["bug"] : [],
          assignees: field === "assignees" ? ["julius"] : [],
        });
        expect(result).toMatchObject({ key: "42", displayKey: "#42", url: ISSUE.html_url });
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings?.[0]).toContain(field);
        expect(requests).toHaveLength(field === "labels" ? 2 : 1);
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
          assignees: field === "assignees" ? ["julius"] : [],
        });
      }),
  );

  it.effect("returns no create warnings when native labels and assignees match", () =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return input.method === "POST"
          ? { stdout: encode({ ...ISSUE, assignees: [{ login: "theo" }, { login: "julius" }] }) }
          : { stdout: encode([{ id: 3, name: "bug" }]) };
      });
      const result = yield* api.create!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        title: "New issue",
        body: "",
        labels: ["bug"],
        assignees: ["julius", "THEO"],
      });
      expect(result.warnings ?? []).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
        assignees: ["julius", "THEO"],
      });
    }),
  );

  it.effect.each([{ assignees: ["julius", "THEO"] }, { assignees: [] }] as const)(
    "accepts an applied native assignee set %s independent of order and username case",
    ({ assignees }) =>
      Effect.gen(function* () {
        const writes: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          writes.push(input);
          return {
            stdout: encode({
              ...ISSUE,
              assignees: assignees.length ? [{ login: "theo" }, { login: "julius" }] : [],
            }),
          };
        });
        yield* api.update!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
          assignees,
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]?.body).toMatchObject({ assignees: [...assignees] });
      }),
  );

  it.effect.each([
    undefined,
    'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/timeline?page=1>; rel="first"',
  ])(
    "marks a filtered native timeline page as partial unless its Link header proves completion %s",
    (stderr) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (input.path.includes("/timeline"))
            return {
              stdout: encode(
                Array.from({ length: 49 }, (_, index) => ({
                  id: index + 1,
                  type: "label",
                  label: { id: 3, name: "bug" },
                  created_at: "2026-07-01T00:00:00Z",
                })),
              ),
              ...(stderr === undefined ? {} : { stderr }),
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(issue.historyTruncated).toBe(true);
        expect(paths.filter((path) => path.includes("/timeline"))).toHaveLength(1);
      }),
  );

  it.effect("honors a smaller requested issue page", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => {
        expect(new URL(input.path, "https://forgejo.test").searchParams.get("limit")).toBe("3");
        return { stdout: encode([ISSUE]), stderr: 'Link: </next>; rel="next"' };
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "forgejo.test",
        scope: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "julius",
        limit: 3,
      });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe("2");
    }),
  );

  it.effect("lists issues by page and leaves pull requests out of the rows", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode([
            ISSUE,
            ...Array.from({ length: 49 }, (_, index) => ({
              ...ISSUE,
              number: 43 + index,
              pull_request: { merged: false },
            })),
          ]),
        };
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        state: "open",
        involvement: "authored",
        viewer: "julius",
        limit: 50,
        cursor: "2",
      });
      expect(paths).toEqual([
        "repos/acme/web/issues?type=issues&state=open&created_by=julius&limit=50&page=2",
      ]);
      expect(page.items.map((item) => item.key)).toEqual(["42"]);
      // No `Link` header at all means the server may still have more; a full page carries on.
      expect(page.nextCursor).toBe("3");
    }),
  );

  it.effect.each([51, 60])(
    "slices an unpaged Gitea response with %s comments without repeats",
    (count) =>
      Effect.gen(function* () {
        const comments = Array.from({ length: count }, (_, index) => ({
          id: index + 1,
          body: `Comment ${index + 1}`,
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const route = input.path.split("?")[0]!;
          if (route === "repos/acme/web/issues/42/comments")
            return { stdout: encode(comments), stderr: `X-Total-Count: ${count}` };
          if (/\/issues\/comments\/\d+\/reactions$/.test(route)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const first = yield* api.getIssue(target);
        expect(first.comments.map((comment) => comment.id)).toEqual(
          Array.from({ length: 50 }, (_, index) => String(count - index)),
        );
        expect(first.commentsCursor).toBeTruthy();
        const second = yield* api.getComments({ ...target, cursor: first.commentsCursor! });
        expect(second.comments.map((comment) => comment.id)).toEqual(
          Array.from({ length: count - 50 }, (_, index) => String(count - 50 - index)),
        );
        expect(second.nextCursor).toBeNull();
        expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
          "repos/acme/web/issues/42/comments?limit=50&page=1",
          "repos/acme/web/issues/42/comments?limit=50&page=1",
        ]);
        expect(paths.filter((path) => path.endsWith("/comments/51/reactions"))).toHaveLength(1);
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(count);
      }),
  );

  it.effect.each([60, 110])(
    "continues after every offset slice of a headerless native page with %s comments",
    (firstCount) =>
      Effect.gen(function* () {
        const comments = Array.from({ length: firstCount + 60 }, (_, index) => ({
          id: index + 1,
          body: `Comment ${index + 1}`,
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const [route, query] = input.path.split("?");
          if (route === "repos/acme/web/issues/42/comments") {
            const page = Number(new URLSearchParams(query).get("page"));
            return {
              stdout: encode(
                page === 1
                  ? comments.slice(0, firstCount)
                  : page === 2
                    ? comments.slice(firstCount)
                    : [],
              ),
            };
          }
          if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const first = yield* api.getIssue(target);
        const ids = first.comments.map((comment) => comment.id);
        expect(ids).toEqual(comments.slice(0, 50).map((comment) => String(comment.id)));
        let cursor = first.commentsCursor;
        const pages = [...Array.from({ length: Math.ceil(firstCount / 50) - 1 }, () => 1), 2, 2, 3];
        for (const page of pages) {
          expect(cursor).not.toBeNull();
          const result = yield* api.getComments({ ...target, order: "asc", cursor: cursor! });
          expect(result.comments.length).toBeLessThanOrEqual(50);
          ids.push(...result.comments.map((comment) => comment.id));
          cursor = result.nextCursor;
          expect(paths.findLast((path) => /\/42\/comments(?:\?|$)/.test(path))).toBe(
            `repos/acme/web/issues/42/comments?limit=50&page=${page}`,
          );
        }
        expect(cursor).toBeNull();
        expect(ids).toEqual(comments.map((comment) => String(comment.id)));
        expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual(
          [1, ...pages].map((page) => `repos/acme/web/issues/42/comments?limit=50&page=${page}`),
        );
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(comments.length);
      }),
  );

  it.effect("keeps the native page while slicing an oversized later comment page", () =>
    Effect.gen(function* () {
      const pages: number[] = [];
      const api = yield* tracker((input) => {
        if (input.path.startsWith("repos/acme/web/issues/42/comments?")) {
          const page = Number(new URL(input.path, "https://forgejo.test").searchParams.get("page"));
          pages.push(page);
          const rows = Array.from({ length: page === 1 ? 1 : 60 }, (_, index) => ({
            id: page === 1 ? 1 : index + 2,
            body: "Comment",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
          }));
          return {
            stdout: encode(rows),
            stderr: page === 1 ? 'Link: </next>; rel="next"' : 'Link: </previous>; rel="prev"',
          };
        }
        if (/\/issues\/comments\/\d+\/reactions$/.test(input.path)) return { stdout: "[]" };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test", scope: "acme/web", key: "42" };
      const first = yield* api.getIssue(target);
      const second = yield* api.getComments({
        ...target,
        order: "asc",
        cursor: first.commentsCursor!,
      });
      expect(second.nextCursor).toBeTruthy();
      const third = yield* api.getComments({ ...target, order: "asc", cursor: second.nextCursor! });
      expect(third.comments.map((comment) => comment.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => String(index + 52)),
      );
      expect(third.nextCursor).toBeNull();
      expect(pages).toEqual([1, 2, 2]);
    }),
  );

  it.effect(
    "continues headerless issue pages below the requested size until a native empty page",
    () =>
      Effect.gen(function* () {
        const issues = Array.from({ length: 50 }, (_, index) => ({ ...ISSUE, number: index + 1 }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
          return { stdout: encode(issues.slice((page - 1) * 20, page * 20)) };
        });
        let cursor: string | undefined;
        const keys: string[] = [];
        for (let page = 1; page <= 4; page++) {
          const result = yield* api.listIssues({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            state: "open",
            involvement: "all",
            viewer: "julius",
            limit: 50,
            cursor,
          });
          keys.push(...result.items.map((issue) => issue.key));
          expect(result.nextCursor).toBe(page === 4 ? null : String(page + 1));
          expect(paths).toHaveLength(page);
          cursor = result.nextCursor ?? undefined;
        }
        expect(keys).toEqual(issues.map((issue) => String(issue.number)));
      }),
  );

  it.effect(
    "continues headerless comment pages below the requested size until a native empty page",
    () =>
      Effect.gen(function* () {
        const comments = Array.from({ length: 50 }, (_, index) => ({
          id: index + 1,
          body: `Comment ${index + 1}`,
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const [route, query] = input.path.split("?");
          if (route === "repos/acme/web/issues/42/comments") {
            const page = Number(new URLSearchParams(query).get("page"));
            return { stdout: encode(comments.slice((page - 1) * 20, page * 20)) };
          }
          if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        let cursor: string | undefined;
        const ids: string[] = [];
        for (let page = 1; page <= 4; page++) {
          const result = yield* api.getComments({
            ...target,
            order: "asc",
            ...(cursor === undefined ? {} : { cursor }),
          });
          ids.push(...result.comments.map((comment) => comment.id));
          expect(result.nextCursor === null).toBe(page === 4);
          expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(page);
          cursor = result.nextCursor ?? undefined;
        }
        expect(ids).toEqual(comments.map((comment) => String(comment.id)));
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(50);
      }),
  );

  it.effect("keeps native Forgejo page cursors and stops at a short final comment page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const route = input.path.split("?")[0]!;
        if (route === "repos/acme/web/issues/42/comments")
          return {
            stdout: encode([
              {
                id: input.path.endsWith("page=1") ? 1 : 51,
                body: "Last comment",
                user: { login: "julius" },
                created_at: "2026-07-02T00:00:00Z",
              },
            ]),
            stderr: input.path.endsWith("page=1")
              ? 'Link: </next>; rel="next"'
              : 'Link: </previous>; rel="prev"',
          };
        if (/\/issues\/comments\/\d+\/reactions$/.test(route)) return { stdout: "[]" };
        return answer(input.path);
      });
      const target = {
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        order: "asc" as const,
      };
      const first = yield* api.getComments(target);
      const page = yield* api.getComments({ ...target, cursor: first.nextCursor! });
      expect(page.comments.map((comment) => comment.id)).toEqual(["51"]);
      expect(page.nextCursor).toBeNull();
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
        "repos/acme/web/issues/42/comments?limit=50&page=1",
        "repos/acme/web/issues/42/comments?limit=50&page=2",
      ]);
    }),
  );

  it.effect.each([
    { name: "a headerless native page with ten later comments", count: 60, paginated: true },
    {
      name: "an exact full unpaged response that ignores the page argument",
      count: 50,
      paginated: false,
    },
    {
      name: "a short unpaged response that ignores the page argument",
      count: 20,
      paginated: false,
    },
  ])("continues a headerless comment page and stops correctly for $name", ({ count, paginated }) =>
    Effect.gen(function* () {
      const comments = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        body: `Comment ${index + 1}`,
        user: { login: "julius" },
        created_at: "2026-07-02T00:00:00Z",
      }));
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const [route, query] = input.path.split("?");
        if (route === "repos/acme/web/issues/42/comments") {
          const page = Number(new URLSearchParams(query).get("page"));
          return {
            stdout: encode(paginated ? comments.slice((page - 1) * 50, page * 50) : comments),
          };
        }
        if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      const first = yield* api.getIssue(target);
      expect(first.comments.map((comment) => comment.id)).toEqual(
        Array.from({ length: Math.min(count, 50) }, (_, index) => String(index + 1)),
      );
      expect(first.commentsCursor).toBeTruthy();
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(1);
      const second = yield* api.getComments({
        ...target,
        order: "asc",
        cursor: first.commentsCursor!,
      });
      expect(second.comments.map((comment) => comment.id)).toEqual(
        paginated ? Array.from({ length: 10 }, (_, index) => String(index + 51)) : [],
      );
      expect(second.nextCursor === null).toBe(!paginated);
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
        "repos/acme/web/issues/42/comments?limit=50&page=1",
        "repos/acme/web/issues/42/comments?limit=50&page=2",
      ]);
      expect(paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path))).toHaveLength(
        count,
      );
      if (paginated) {
        const last = yield* api.getComments({
          ...target,
          order: "asc",
          cursor: second.nextCursor!,
        });
        expect(last.comments).toEqual([]);
        expect(last.nextCursor).toBeNull();
        expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(3);
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(count);
      }
    }),
  );
});
