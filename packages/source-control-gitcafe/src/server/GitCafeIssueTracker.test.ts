import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeIssueTracker from "./GitCafeIssueTracker.ts";
import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";

const timestamp = "2026-10-15T12:00:00Z";
const actor = {
  kind: "local",
  actorId: "act_alice",
  handle: "alice",
  displayName: null,
  avatarUrl: null,
};
const issue = {
  id: "issue_one",
  number: 7,
  title: "Native issue",
  description: "Body",
  stateType: "triage",
  version: 4,
  author: actor,
  createdAt: timestamp,
  updatedAt: timestamp,
  closedAt: null,
  closedReason: null,
  labels: [],
  assignees: [],
  milestone: null,
  capabilities: {
    edit: true,
    comment: true,
    close: true,
    reopen: false,
    manageLabels: true,
    manageAssignees: true,
  },
};
const comment = {
  id: "comment_one",
  issueId: "issue_one",
  author: actor,
  body: "Comment",
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
  capabilities: { edit: true, delete: true },
};
const target = { cwd: "/repo", host: "git.cafe", scope: "owner/repo", key: "7" };
const base = "/repos/owner/repo/issues/7";
const page = { items: [], next: null };

describe("GitCafe comment ordering", () => {
  it.effect("keeps partial detail readable and refuses a false newest page", () => {
    const fake = harness({ [`GET ${base}/comments/`]: { items: [comment], next: "page_two" } });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const detail = yield* api.getIssue(target);
      assert.deepStrictEqual(detail.capabilities?.commentOrders, ["asc"]);
      assert.strictEqual(detail.comments[0]?.id, "comment_one");
      fake.sent.length = 0;
      const error = yield* api.getComments({ ...target, order: "desc" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
      assert.strictEqual(fake.sent.length, 1);
      assert.strictEqual(fake.sent[0]?.query.has("direction"), false);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("sorts a complete native page in both directions", () => {
    const fake = harness({
      [`GET ${base}/comments/`]: {
        items: [
          { ...comment, id: "old", createdAt: "2026-10-01T00:00:00Z" },
          { ...comment, id: "new", createdAt: "2026-10-03T00:00:00Z" },
          { ...comment, id: "middle", createdAt: "2026-10-02T00:00:00Z" },
        ],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      assert.deepStrictEqual(
        (yield* api.getIssue(target)).comments.map((row) => row.id),
        ["new", "middle", "old"],
      );
      assert.deepStrictEqual(
        (yield* api.getComments({ ...target, order: "asc" })).comments.map((row) => row.id),
        ["old", "middle", "new"],
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("rejects changed context before HTTP and repeated native pages after one read", () => {
    const fake = harness({ [`GET ${base}/comments/`]: { items: [comment], next: "page_two" } });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const first = yield* api.getComments({ ...target, order: "asc", connectionId: "account-a" });
      assert.ok(first.nextCursor);
      fake.sent.length = 0;
      for (const change of [
        { connectionId: "account-b" },
        { order: "desc" as const },
        { cwd: "/other" },
        { scope: "other/repo" },
        { key: "8" },
        { host: "other.test" },
        { cursor: "page_two" },
        { cursor: first.nextCursor + "x" },
      ]) {
        yield* api
          .getComments({
            ...target,
            order: "asc",
            connectionId: "account-a",
            cursor: first.nextCursor!,
            ...change,
          })
          .pipe(Effect.flip);
      }
      assert.strictEqual(fake.sent.length, 0);
      yield* api
        .getComments({ ...target, order: "asc", cursor: first.nextCursor! })
        .pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 0);
      yield* api
        .getComments({
          ...target,
          order: "asc",
          connectionId: "account-a",
          cursor: first.nextCursor!,
        })
        .pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("continues native oldest-first pages without losing or repeating rows", () => {
    const fake = harness({
      [`GET ${base}/comments/`]: ({ query }: Sent) => ({
        items: [
          {
            ...comment,
            id: query.has("after") ? "second" : "first",
            createdAt: query.has("after") ? "2026-10-02T00:00:00Z" : "2026-10-01T00:00:00Z",
          },
        ],
        next: query.has("after") ? null : "page_two",
      }),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const first = yield* api.getComments({ ...target, order: "asc" });
      const second = yield* api.getComments({ ...target, order: "asc", cursor: first.nextCursor! });
      assert.deepStrictEqual(
        [...first.comments, ...second.comments].map((row) => row.id),
        ["first", "second"],
      );
      assert.strictEqual(second.nextCursor, null);
      assert.strictEqual(fake.sent.filter((row) => row.path.endsWith("/comments/")).length, 2);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("restores both orders when the native window becomes complete", () => {
    let complete = false;
    const fake = harness({
      [`GET ${base}/comments/`]: () => ({ items: [comment], next: complete ? null : "page_two" }),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const partial = yield* api.getIssue(target);
      assert.deepStrictEqual(partial.capabilities?.commentOrders, ["asc"]);
      complete = true;
      const whole = yield* api.getIssue(target);
      assert.strictEqual(whole.capabilities?.commentOrders, undefined);
      assert.strictEqual(whole.commentsCursor, null);
      fake.sent.length = 0;
      yield* api
        .getComments({ ...target, cursor: partial.commentsCursor!, order: "desc" })
        .pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses oversized native cursor envelopes without truncation or further reads", () => {
    const native = "a".repeat(8192);
    const fake = harness({ [`GET ${base}/comments/`]: { items: [comment], next: native } });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.getComments({ ...target, order: "asc" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
      assert.match(error.detail, /size/);
      assert.strictEqual(fake.sent.length, 1);
      assert.strictEqual(fake.sent[0]?.query.get("after"), null);
    }).pipe(Effect.provide(fake.layer));
  });
});

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function harness(routes: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const invalidated: string[] = [];
  const defaults: Record<string, unknown> = {
    "GET /auth/principal": { actorId: "act_alice", handle: "alice" },
    [`GET ${base}`]: issue,
    [`GET ${base}/comments/`]: { items: [comment], next: null },
    [`GET ${base}/links/`]: page,
    [`GET ${base}/reactions/`]: page,
    "GET /repos/owner/repo/labels": page,
    "GET /repos/owner/repo/issues/assignee-candidates": page,
  };
  const client = HttpClient.make((request, _url, _signal, fiber) => {
    const url = new URL(request.url);
    assert.strictEqual(url.origin, "https://git.cafe");
    assert.strictEqual(request.headers.authorization, "Bearer fake-token");
    assert.strictEqual(
      Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      "manual",
    );
    const input: Sent = {
      method: request.method,
      path: url.pathname.slice(4),
      query: url.searchParams,
      body:
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined,
    };
    sent.push(input);
    const route = { ...defaults, ...routes }[`${input.method} ${input.path}`];
    const value = typeof route === "function" ? route(input) : route;
    const response =
      value instanceof Response
        ? value.clone()
        : new Response(JSON.stringify(value ?? {}), { status: route === undefined ? 404 : 200 });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = GitCafeApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(
      Layer.succeed(GitCafeCredentials.GitCafeCredentials, {
        get: (host) => Effect.succeed({ host, token: Redacted.make("fake-token"), source: "env" }),
        invalidate: (host) =>
          Effect.sync(() => {
            invalidated.push(host);
          }),
        cliEnv: () => Effect.succeed({}),
      }),
    ),
  );
  return { layer, sent, invalidated };
}

const templateCommit = "a".repeat(40);
const templateBlob = "b".repeat(40);
const templatePath = ".gitcafe/ISSUE_TEMPLATE/Bug.md";
const templateKey = `${templateCommit}:${templatePath}`;
const treeEntry = (path: string, kind = "blob") => ({
  name: path.split("/").at(-1),
  path,
  oid: templateBlob,
  kind,
});
const tree = (items: ReturnType<typeof treeEntry>[], next: string | null = null) => ({
  oid: "c".repeat(40),
  items,
  next,
});
const templateRoutes = (entries = [treeEntry(templatePath)], body = "## Describe the bug\n") => ({
  "GET /repos/owner/repo/commits": { items: [{ oid: templateCommit }], next: null },
  "GET /repos/owner/repo/tree": ({ query }: Sent) => {
    assert.strictEqual(query.get("oid"), templateCommit);
    switch (query.get("path")) {
      case ".gitcafe":
        return tree([treeEntry(".gitcafe/ISSUE_TEMPLATE", "tree")]);
      case ".gitcafe/ISSUE_TEMPLATE":
        return tree(entries);
      default:
        return new Response("missing", { status: 404 });
    }
  },
  "GET /repos/owner/repo/blob": ({ query }: Sent) => ({
    commit: templateCommit,
    oid: templateBlob,
    path: query.get("path"),
    size: new TextEncoder().encode(body).length,
    binary: false,
    content: body,
  }),
});

describe("GitCafe issue templates", () => {
  it.effect(
    "lists native templates without bodies and loads only the selected immutable body",
    () => {
      const body = "---\nunknown: preserve this\n---\n## Report\n";
      const fake = harness(templateRoutes([treeEntry(templatePath)], body));
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        assert.strictEqual(api.capabilities.templates, true);
        const list = yield* api.listTemplates!({ ...target, metadataOnly: true });
        assert.deepStrictEqual(list, {
          templates: [
            {
              key: templateKey,
              name: "Bug.md",
              about: "",
              title: "",
              body: "",
              labels: [],
              assignees: [],
              contentDeferred: true,
            },
          ],
          blankIssuesEnabled: true,
        });
        assert.strictEqual(fake.sent.length, 3);
        assert.strictEqual(
          fake.sent.some((request) => request.path.endsWith("/blob")),
          false,
        );
        const selected = yield* api.listTemplates!({ ...target, templateKey });
        assert.strictEqual(selected.templates[0]?.body, body);
        assert.strictEqual(selected.templates[0]?.contentDeferred, undefined);
        assert.strictEqual(fake.sent.length, 6);
        assert.strictEqual(fake.sent.at(-1)?.query.get("oid"), templateCommit);
        assert.strictEqual(fake.sent.at(-1)?.query.get("path"), templatePath);
        assert.isTrue(fake.sent.every((request) => request.method === "GET"));
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("creates an issue from an edited template body without extra reads", () => {
    const fake = harness({ "POST /repos/owner/repo/issues/": issue });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.create!({
        ...target,
        templateKey,
        title: "A bug",
        body: "Edited template body",
        labels: [],
        assignees: [],
      });
      assert.strictEqual(fake.sent.length, 1);
      assert.deepStrictEqual(fake.sent[0]?.body, {
        title: "A bug",
        description: "Edited template body",
        labelIds: [],
        assigneeIds: [],
      });
      yield* api.create!({
        ...target,
        templateKey: "../foreign",
        title: "A bug",
        body: "Body",
        labels: [],
        assignees: [],
      }).pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("loads the complete catalog when no lazy selection is requested", () => {
    const fake = harness(templateRoutes());
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const list = yield* api.listTemplates!(target);
      assert.strictEqual(list.templates[0]?.body, "## Describe the bug\n");
      assert.strictEqual(fake.sent.length, 4);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect.each([
    { commit: "d".repeat(40) },
    { oid: "d".repeat(40) },
    { path: "README.md" },
    { binary: true },
    { content: null },
    { size: 2 },
    { size: 1048577 },
    { content: "x".repeat(1048577) },
  ])("rejects a malformed, foreign or oversized template blob %#", (value) => {
    const fake = harness({
      ...templateRoutes(),
      "GET /repos/owner/repo/blob": {
        commit: templateCommit,
        oid: templateBlob,
        path: templatePath,
        size: 1,
        binary: false,
        content: "x",
        ...value,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.listTemplates!({ ...target, templateKey }).pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 3);
      assert.isTrue(fake.sent.every((request) => request.method === "GET"));
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("bounds total template bytes and counts UTF-8 bytes", () => {
    const entries = [treeEntry(templatePath), treeEntry(".gitcafe/ISSUE_TEMPLATE/Task.md")];
    const fake = harness(templateRoutes(entries, "é".repeat(300_000)));
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.listTemplates!(target).pipe(Effect.flip);
      assert.include(error.detail, "1 MiB");
      assert.strictEqual(fake.sent.length, 5);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect.each([
    { items: [], next: null },
    tree([treeEntry("other/repo/Bug.md")]),
    tree([treeEntry(templatePath), treeEntry(templatePath)]),
    tree([treeEntry(templatePath)], "bad.cursor"),
    tree(Array.from({ length: 201 }, (_, i) => treeEntry(`.gitcafe/ISSUE_TEMPLATE/${i}.md`))),
  ])("fails on malformed or foreign template tree pages %#", (response) => {
    const routes = templateRoutes();
    const fake = harness({
      ...routes,
      "GET /repos/owner/repo/tree": (input: Sent) =>
        input.query.get("path") === ".gitcafe/ISSUE_TEMPLATE"
          ? response
          : routes["GET /repos/owner/repo/tree"](input),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.listTemplates!({ ...target, metadataOnly: true }).pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("follows native tree cursors on one commit and rejects a cycle", () => {
    const routes = templateRoutes();
    const fake = harness({
      ...routes,
      "GET /repos/owner/repo/tree": (input: Sent) => {
        if (input.query.get("path") !== ".gitcafe/ISSUE_TEMPLATE")
          return routes["GET /repos/owner/repo/tree"](input);
        return input.query.get("after") === null
          ? tree([treeEntry(templatePath)], "next_page")
          : tree([treeEntry(".gitcafe/ISSUE_TEMPLATE/Task.txt")]);
      },
    });
    const cycle = harness({
      ...routes,
      "GET /repos/owner/repo/tree": (input: Sent) =>
        input.query.get("path") === ".gitcafe/ISSUE_TEMPLATE"
          ? tree([], "same")
          : routes["GET /repos/owner/repo/tree"](input),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const list = yield* api.listTemplates!({ ...target, metadataOnly: true });
      assert.strictEqual(list.templates.length, 2);
      assert.strictEqual(fake.sent.length, 4);
      assert.strictEqual(fake.sent.at(-1)?.query.get("after"), "next_page");
    }).pipe(
      Effect.provide(fake.layer),
      Effect.andThen(
        Effect.gen(function* () {
          const api = yield* GitCafeIssueTracker.make;
          yield* api.listTemplates!({ ...target, metadataOnly: true }).pipe(Effect.flip);
          assert.strictEqual(cycle.sent.length, 4);
        }).pipe(Effect.provide(cycle.layer)),
      ),
    );
  });

  it.effect("bounds tree pages and does not treat a missing known directory as empty", () => {
    const routes = templateRoutes();
    const bounded = harness({
      ...routes,
      "GET /repos/owner/repo/tree": (input: Sent) =>
        input.query.get("path") === ".gitcafe/ISSUE_TEMPLATE"
          ? tree([], `page_${input.query.get("after") ?? "0"}`)
          : routes["GET /repos/owner/repo/tree"](input),
    });
    const missing = harness({
      ...routes,
      "GET /repos/owner/repo/tree": (input: Sent) =>
        input.query.get("path") === ".gitcafe/ISSUE_TEMPLATE"
          ? new Response("missing", { status: 404 })
          : routes["GET /repos/owner/repo/tree"](input),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.listTemplates!({ ...target, metadataOnly: true }).pipe(Effect.flip);
      assert.include(error.detail, "page limit");
      assert.strictEqual(bounded.sent.length, 12);
    }).pipe(
      Effect.provide(bounded.layer),
      Effect.andThen(
        Effect.gen(function* () {
          const api = yield* GitCafeIssueTracker.make;
          const error = yield* api.listTemplates!({ ...target, metadataOnly: true }).pipe(
            Effect.flip,
          );
          assert.strictEqual(error.reason, "not-found");
        }).pipe(Effect.provide(missing.layer)),
      ),
    );
  });

  it.effect(
    "uses GitHub templates when GitCafe metadata is absent and never follows symlinks",
    () => {
      const fake = harness({
        ...templateRoutes(),
        "GET /repos/owner/repo/tree": ({ query }: Sent) => {
          const path = query.get("path");
          if (path === ".gitcafe") return new Response("missing", { status: 404 });
          if (path === ".github") return tree([treeEntry(".github/ISSUE_TEMPLATE", "tree")]);
          return tree([
            treeEntry(".github/ISSUE_TEMPLATE/Task.txt"),
            treeEntry(".github/ISSUE_TEMPLATE/Link.md", "symlink"),
          ]);
        },
      });
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const list = yield* api.listTemplates!({ ...target, metadataOnly: true });
        assert.deepStrictEqual(
          list.templates.map((item) => item.name),
          ["Task.txt"],
        );
        assert.strictEqual(fake.sent.length, 4);
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("does not read from a foreign host or repository scope", () => {
    const fake = harness(templateRoutes());
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      for (const input of [
        { ...target, host: "other.example" },
        { ...target, scope: "owner/repo/foreign" },
      ])
        yield* api.listTemplates!({ ...input, metadataOnly: true }).pipe(Effect.flip);
      yield* api.listTemplates!({ ...target, metadataOnly: true, templateKey }).pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reads all supported extensions and prefers the GitCafe directory", () => {
    const paths = ["Bug.md", "Task.markdown", "Help.txt", "form.yml", "nested"].map((name) =>
      treeEntry(`.gitcafe/ISSUE_TEMPLATE/${name}`, name === "nested" ? "tree" : "blob"),
    );
    const fake = harness(templateRoutes(paths));
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const list = yield* api.listTemplates!({ ...target, metadataOnly: true });
      assert.deepStrictEqual(
        list.templates.map((item) => item.name),
        ["Bug.md", "Task.markdown", "Help.txt"],
      );
      assert.strictEqual(
        fake.sent.some((request) => request.query.get("path")?.startsWith(".github")),
        false,
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect.each(
    [".gitcafe", ".github"].flatMap((prefix) =>
      ["ISSUE_TEMPLATE.md", "ISSUE_TEMPLATE", "issue_template.md"].map((filename) => ({
        prefix,
        filename,
      })),
    ),
  )("uses the $prefix/$filename fallback", ({ prefix, filename }) => {
    const path = `${prefix}/${filename}`;
    const fake = harness({
      ...templateRoutes(),
      "GET /repos/owner/repo/tree": ({ query }: Sent) =>
        tree(query.get("path") === prefix ? [treeEntry(path)] : []),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.listTemplates!({ ...target, metadataOnly: true });
      assert.strictEqual(result.templates[0]?.key, `${templateCommit}:${path}`);
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("prefers a GitHub template directory over a single-file fallback", () => {
    const fake = harness({
      ...templateRoutes(),
      "GET /repos/owner/repo/tree": ({ query }: Sent) => {
        const path = query.get("path");
        return tree(
          path === ".gitcafe"
            ? [treeEntry(".gitcafe/ISSUE_TEMPLATE.md")]
            : path === ".github"
              ? [treeEntry(".github/ISSUE_TEMPLATE", "tree")]
              : [treeEntry(".github/ISSUE_TEMPLATE/Task.txt")],
        );
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const list = yield* api.listTemplates!({ ...target, metadataOnly: true });
      assert.strictEqual(list.templates[0]?.name, "Task.txt");
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("returns an empty catalog for a repository without templates", () => {
    const fake = harness({ ...templateRoutes(), "GET /repos/owner/repo/tree": tree([]) });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      assert.deepStrictEqual(yield* api.listTemplates!({ ...target, metadataOnly: true }), {
        templates: [],
        blankIssuesEnabled: true,
      });
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("keeps an empty template body usable", () => {
    const fake = harness(templateRoutes([treeEntry(templatePath)], ""));
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const list = yield* api.listTemplates!({ ...target, templateKey });
      assert.strictEqual(list.templates[0]?.body, "");
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("stops at 20 templates without fetching bodies for metadata", () => {
    const entries = Array.from({ length: 21 }, (_, i) =>
      treeEntry(`.gitcafe/ISSUE_TEMPLATE/${i}.md`),
    );
    const fake = harness(templateRoutes(entries));
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const list = yield* api.listTemplates!({ ...target, metadataOnly: true });
      assert.strictEqual(list.templates.length, 20);
      assert.strictEqual(fake.sent.length, 3);
      const error = yield* api.listTemplates!({
        ...target,
        templateKey: `${templateCommit}:${entries[20]!.path}`,
      }).pipe(Effect.flip);
      assert.include(error.detail, "template");
      assert.isTrue(
        fake.sent.every((request) => request.method === "GET" && !request.path.endsWith("/blob")),
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect.each([
    "../secret",
    `${templateCommit}:README.md`,
    `${templateCommit}:.gitcafe/ISSUE_TEMPLATE/../secret.md`,
    `${templateCommit}:.gitcafe/ISSUE_TEMPLATE/%2e%2e/secret.md`,
  ])("rejects a foreign or unsafe template key %s", (key) => {
    const fake = harness(templateRoutes());
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.listTemplates!({ ...target, templateKey: key }).pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect.each([401, 429])("preserves native HTTP %s on selected template reads", (status) => {
    const fake = harness({
      ...templateRoutes(),
      "GET /repos/owner/repo/blob": new Response("private", {
        status,
        headers: { "retry-after": "17" },
      }),
    });
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.listTemplates!({ ...target, templateKey }).pipe(Effect.flip);
      assert.strictEqual(error.reason, status === 401 ? "unauthenticated" : "rate-limited");
      if (status === 429) assert.strictEqual(error.retryAt, now + 17_000);
      assert.deepStrictEqual(fake.invalidated, status === 401 ? ["git.cafe"] : []);
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("GitCafeIssueTracker", () => {
  it.effect("preserves full native cursors without cutting them", () => {
    const cursor = "a".repeat(8192);
    const fake = harness({ "GET /repos/owner/repo/issues/": { items: [issue], next: cursor } });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const input = {
        ...target,
        state: "all" as const,
        involvement: "all" as const,
        viewer: "alice",
        limit: 1,
      };
      const first = yield* api.listIssues(input);
      assert.strictEqual(first.nextCursor, cursor);
      yield* api.listIssues({ ...input, cursor }).pipe(Effect.flip);
      assert.strictEqual(fake.sent[1]?.query.get("after"), cursor);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect(
    "does not turn unreadable, oversized or foreign conversation pages into empty success",
    () => {
      const malformed = harness({
        "GET /repos/owner/repo/issues/": { items: [{ number: "bad" }], next: null },
      });
      const oversized = harness({
        "GET /repos/owner/repo/issues/": { items: [issue, issue], next: null },
      });
      const foreign = harness({
        [`GET ${base}/comments/`]: {
          items: [{ ...comment, issueId: "another_issue" }],
          next: null,
        },
      });
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const error = yield* api
          .listIssues({ ...target, state: "all", involvement: "all", viewer: "alice", limit: 1 })
          .pipe(Effect.flip);
        assert.include(error.detail, "unreadable");
      }).pipe(
        Effect.provide(malformed.layer),
        Effect.andThen(
          Effect.gen(function* () {
            const api = yield* GitCafeIssueTracker.make;
            const error = yield* api
              .listIssues({
                ...target,
                state: "all",
                involvement: "all",
                viewer: "alice",
                limit: 1,
              })
              .pipe(Effect.flip);
            assert.include(error.detail, "continuation");
          }).pipe(Effect.provide(oversized.layer)),
        ),
        Effect.andThen(
          Effect.gen(function* () {
            const api = yield* GitCafeIssueTracker.make;
            const error = yield* api.getIssue(target).pipe(Effect.flip);
            assert.include(error.detail, "different issue");
          }).pipe(Effect.provide(foreign.layer)),
        ),
      );
    },
  );

  it.effect("keeps unavailable assignee IDs and ignores a malformed avatar", () => {
    const unavailable = {
      id: "act_missing",
      actor: { kind: "unavailable", actorId: "act_missing" },
    };
    const fake = harness({
      [`GET ${base}`]: {
        ...issue,
        author: { ...actor, avatarUrl: "http://[" },
        assignees: [unavailable],
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.getIssue(target);
      assert.strictEqual(result.assignees[0]?.id, "act_missing");
      assert.strictEqual(result.assignees[0]?.login, "act_missing");
      assert.strictEqual(result.author?.avatarUrl, null);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("does not require code-read scope to display an issue without reaction access", () => {
    const fake = harness({ [`GET ${base}/reactions/`]: new Response("denied", { status: 403 }) });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.getIssue(target);
      assert.strictEqual(result.title, issue.title);
      assert.strictEqual(result.reactions, undefined);
      assert.strictEqual(result.comments[0]?.reactions, undefined);
      assert.strictEqual(fake.sent.length, 5);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("keeps issue and comment reactions apart when native IDs match", () => {
    const reaction = {
      emoji: { kind: "unicode", value: "👍" },
      count: 1,
      viewerReactionId: null,
      reactors: [],
    };
    const fake = harness({
      [`GET ${base}/comments/`]: { items: [{ ...comment, id: "issue_one" }], next: null },
      [`GET ${base}/reactions/`]: {
        items: [
          { ...reaction, subject: { kind: "issue", id: "issue_one" } },
          { ...reaction, count: 2, subject: { kind: "issue_comment", id: "issue_one" } },
        ],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.getIssue(target);
      assert.strictEqual(result.reactions?.[0]?.count, 1);
      assert.strictEqual(result.comments[0]?.reactions?.[0]?.count, 2);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("bounds comment lookup and refuses native per-comment edit denial", () => {
    const missing = harness({
      [`GET ${base}/comments/`]: (input: Sent) => ({
        items: [],
        next: `page_${Number(input.query.get("after")?.slice(5) ?? 0) + 1}`,
      }),
    });
    const denied = harness({
      [`GET ${base}/comments/`]: {
        items: [{ ...comment, capabilities: { edit: false, delete: false } }],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.editComment!({ ...target, commentId: "missing", body: "Edit" }).pipe(
        Effect.flip,
      );
      assert.include(error.detail, "bound");
      assert.strictEqual(missing.sent.length, 10);
    }).pipe(
      Effect.provide(missing.layer),
      Effect.andThen(
        Effect.gen(function* () {
          const api = yield* GitCafeIssueTracker.make;
          const error = yield* api.editComment!({
            ...target,
            commentId: comment.id,
            body: "Edit",
          }).pipe(Effect.flip);
          assert.include(error.detail, "does not allow");
          assert.strictEqual(denied.sent.length, 1);
        }).pipe(Effect.provide(denied.layer)),
      ),
    );
  });
  it.effect("uses native actor IDs and explicit all-state filters with one list page", () => {
    const fake = harness({
      "GET /repos/owner/repo/issues/": { items: [issue], next: "next_page" },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "assigned",
        viewer: "alice",
        limit: 200,
        sort: "updated",
        order: "asc",
        query: "fix",
      });
      assert.strictEqual(result.nextCursor, "next_page");
      assert.strictEqual(result.items[0]?.author?.id, "act_alice");
      assert.strictEqual(fake.sent.length, 2);
      const query = fake.sent[1]!.query;
      assert.deepStrictEqual(query.getAll("statuses"), ["open", "closed"]);
      assert.strictEqual(query.get("assignee"), "act_alice");
      assert.strictEqual(query.get("limit"), "100");
      assert.strictEqual(query.get("direction"), "asc");
      assert.strictEqual(query.get("q"), "fix");
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect.each([
    {
      categories: ["backlog", "unstarted", "started"],
      state: "open",
      states: ["triage", "backlog", "unstarted", "started"],
    },
    { categories: ["backlog"], state: "open", states: ["triage", "backlog"] },
    { categories: ["unstarted"], state: "open", states: ["triage", "unstarted"] },
    { categories: ["started"], state: "open", states: ["triage", "started"] },
    { categories: ["completed", "canceled"], state: "closed", states: ["completed", "canceled"] },
    { categories: ["backlog", "unstarted", "started"], state: "closed", states: [] },
  ] as const)(
    "keeps triage reachable for $state categories $categories",
    ({ categories, state, states }) => {
      const fake = harness({
        "GET /repos/owner/repo/issues/": ({ query }: Sent) => ({
          items: query.getAll("states").includes("triage") ? [issue] : [],
          next: null,
        }),
      });
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const result = yield* api.listIssues({
          ...target,
          state,
          stateCategories: categories,
          involvement: "all",
          viewer: "alice",
          limit: 50,
        });
        assert.strictEqual(result.items.length, states.some((value) => value === "triage") ? 1 : 0);
        if (states.length === 0) assert.strictEqual(fake.sent.length, 0);
        else {
          assert.strictEqual(fake.sent.length, 1);
          assert.deepStrictEqual(fake.sent[0]!.query.getAll("states"), [...states]);
          if (result.items.length > 0) {
            assert.strictEqual(result.items[0]?.state.id, "triage");
            assert.strictEqual(result.items[0]?.state.category, "open");
          }
        }
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("handles terminal pages, empty categories and account changes without guessing", () => {
    const fake = harness({ "GET /repos/owner/repo/issues/": page });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const input = {
        ...target,
        state: "all" as const,
        involvement: "all" as const,
        viewer: "alice",
        limit: 10,
      };
      const empty = yield* api.listIssues({ ...input, stateCategories: [] });
      assert.deepStrictEqual(empty, { items: [], nextCursor: null });
      assert.strictEqual(fake.sent.length, 0);
      const terminal = yield* api.listIssues(input);
      assert.deepStrictEqual(terminal, empty);
      const changed = yield* api
        .listIssues({ ...input, involvement: "authored", viewer: "bob" })
        .pipe(Effect.flip);
      assert.include(changed.detail, "account changed");
      assert.strictEqual(fake.sent.length, 2);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("rejects malformed, oversized and repeated continuation pages", () => {
    const fake = harness({ "GET /repos/owner/repo/issues/": { items: [issue], next: "same" } });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const input = {
        ...target,
        state: "all" as const,
        involvement: "all" as const,
        viewer: "alice",
        limit: 10,
      };
      const repeated = yield* api.listIssues({ ...input, cursor: "same" }).pipe(Effect.flip);
      assert.include(repeated.detail, "continuation");
      const invalid = yield* api.listIssues({ ...input, cursor: "bad?cursor" }).pipe(Effect.flip);
      assert.include(invalid.detail, "page parameters");
      const forbidden = yield* api.listIssues({ ...input, host: "cafe.sh" }).pipe(Effect.flip);
      assert.include(forbidden.detail, "supported host");
      assert.strictEqual(fake.sent.length, 1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("loads comments and linked PRs as separate pages without extra PR reads", () => {
    const fake = harness({
      [`GET ${base}/comments/`]: { items: [comment], next: "older" },
      [`GET ${base}/links/`]: {
        items: [
          { issueId: "issue_one", number: 9, title: "Fix", state: "open", linkType: "closes" },
        ],
        next: "links_next",
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const comments = yield* api.getComments({ ...target, order: "asc" });
      assert.ok(comments.nextCursor);
      assert.strictEqual(fake.sent[0]?.query.get("after"), null);
      const links = yield* api.getLinkedPullRequests!({ ...target, limit: 5 });
      assert.strictEqual(links.nextCursor, "links_next");
      assert.strictEqual(links.items[0]?.url, "https://git.cafe/owner/repo/pulls/9");
      assert.strictEqual(links.items[0]?.closesIssue, true);
      assert.strictEqual(links.items[0]?.isDraft, undefined);
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("creates with native metadata IDs in one write", () => {
    const fake = harness({ "POST /repos/owner/repo/issues/": issue });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const created = yield* api.create!({
        ...target,
        title: "New",
        body: "Text",
        labels: ["label_one"],
        assignees: ["act_alice"],
      });
      assert.strictEqual(created.key, "7");
      assert.deepStrictEqual(fake.sent[0]?.body, {
        title: "New",
        description: "Text",
        labelIds: ["label_one"],
        assigneeIds: ["act_alice"],
      });
      assert.strictEqual(fake.sent.length, 1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("chains versions across word, label and assignee writes", () => {
    let version = 4;
    const write = (input: Sent) => {
      assert.strictEqual((input.body as { expectedVersion: number }).expectedVersion, version);
      version++;
      return { version };
    };
    const fake = harness({
      [`PATCH ${base}`]: write,
      [`PUT ${base}/labels`]: write,
      [`PUT ${base}/assignees`]: write,
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.update!({
        ...target,
        title: "Edit",
        body: "New body",
        labels: [],
        assignees: ["act_alice"],
      });
      assert.strictEqual(fake.sent.length, 4);
      assert.strictEqual(version, 7);
      assert.deepStrictEqual(fake.sent[2]?.body, { expectedVersion: 5, labelIds: [] });
      assert.deepStrictEqual(fake.sent[3]?.body, { expectedVersion: 6, actorIds: ["act_alice"] });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("preflights permissions and reports partial edits without sending later writes", () => {
    const fake = harness({
      [`PATCH ${base}`]: { version: 5 },
      [`PUT ${base}/labels`]: new Response("private input", { status: 409 }),
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.update!({
        ...target,
        title: "Edit",
        labels: [],
        assignees: [],
      }).pipe(Effect.flip);
      assert.include(error.detail, "saved part");
      assert.notInclude(error.detail, "private input");
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses revoked metadata, comment and lifecycle permissions before writes", () => {
    const fake = harness({
      [`GET ${base}`]: {
        ...issue,
        capabilities: { ...issue.capabilities, manageLabels: false, close: false, comment: false },
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.update!({ ...target, labels: [] }).pipe(Effect.flip);
      yield* api.setState!({ ...target, state: "completed" }).pipe(Effect.flip);
      yield* api.comment!({ ...target, body: "No" }).pipe(Effect.flip);
      assert.strictEqual(fake.sent.length, 3);
      assert.isTrue(fake.sent.every((request) => request.method === "GET"));
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reopens then sets the requested workflow state with the returned version", () => {
    const closed = {
      ...issue,
      stateType: "completed",
      capabilities: { ...issue.capabilities, reopen: true },
    };
    const fake = harness({
      [`GET ${base}`]: closed,
      [`POST ${base}/reopen`]: { ...issue, version: 5, stateType: "unstarted" },
      [`PATCH ${base}`]: { ...issue, version: 6, stateType: "started" },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.setState!({ ...target, state: "started" });
      assert.deepStrictEqual(fake.sent[1]?.body, { expectedVersion: 4 });
      assert.deepStrictEqual(fake.sent[2]?.body, { expectedVersion: 5, state: "started" });
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("closes as canceled and keeps comment edits on native IDs and versions", () => {
    const fake = harness({
      [`POST ${base}/close`]: { ...issue, stateType: "canceled", version: 5 },
      [`POST ${base}/comments/`]: comment,
      [`PATCH ${base}/comments/comment_one`]: comment,
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.setState!({ ...target, state: "canceled" });
      assert.deepStrictEqual(fake.sent[1]?.body, { expectedVersion: 4, state: "canceled" });
      yield* api.comment!({ ...target, body: "Text" });
      yield* api.editComment!({ ...target, commentId: "comment_one", body: "Edit" });
      assert.deepStrictEqual(fake.sent.at(-1)?.body, { expectedVersion: 2, body: "Edit" });
      assert.strictEqual(fake.sent.length, 6);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("pages label and assignee choices with stable IDs and real truncation", () => {
    const fake = harness({
      "GET /repos/owner/repo/labels": {
        items: [{ id: "label_one", name: "bug", color: "#ff0000", description: null }],
        next: "labels_more",
      },
      "GET /repos/owner/repo/issues/assignee-candidates": {
        items: [{ id: "act_alice", actor }],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const result = yield* api.listCandidates!(target);
      assert.strictEqual(result.labels[0]?.id, "label_one");
      assert.strictEqual(result.assignees[0]?.id, "act_alice");
      assert.strictEqual(result.truncated, true);
      const next = yield* api.listLabelCandidates!({ ...target, cursor: "labels_first", limit: 7 });
      assert.strictEqual(next.nextCursor, "labels_more");
      assert.strictEqual(fake.sent[2]?.query.get("after"), "labels_first");
      assert.strictEqual(fake.sent.length, 3);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("adds and removes native reactions using the viewer reaction ID", () => {
    let reacted = false;
    const fake = harness({
      [`GET ${base}/reactions/`]: () => ({
        items: reacted
          ? [
              {
                subject: { kind: "issue", id: "issue_one" },
                emoji: { kind: "unicode", value: "👍" },
                count: 1,
                viewerReactionId: "reaction_one",
                reactors: [actor],
              },
            ]
          : [],
        next: null,
      }),
      [`POST ${base}/reactions/`]: () => {
        reacted = true;
        return {};
      },
      [`DELETE ${base}/reactions/reaction_one`]: () => {
        reacted = false;
        return new Response(null, { status: 204 });
      },
    });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      yield* api.setReaction!({ ...target, content: "thumbs-up", reacted: true });
      yield* api.setReaction!({ ...target, content: "thumbs-up", reacted: true });
      yield* api.setReaction!({ ...target, content: "thumbs-up", reacted: false });
      assert.strictEqual(reacted, false);
      assert.strictEqual(fake.sent.filter((value) => value.method === "POST").length, 1);
      assert.strictEqual(fake.sent.filter((value) => value.method === "DELETE").length, 1);
      assert.strictEqual(fake.sent.length, 8);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect(
    "bounds reaction scans and refuses removal when the viewer record is not reached",
    () => {
      const fake = harness({
        [`GET ${base}/reactions/`]: (input: Sent) => ({
          items: [],
          next: `page_${Number(input.query.get("after")?.slice(5) ?? 0) + 1}`,
        }),
      });
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const error = yield* api.setReaction!({ ...target, content: "heart", reacted: false }).pipe(
          Effect.flip,
        );
        assert.include(error.detail, "incomplete");
        assert.strictEqual(fake.sent.length, 11);
        assert.isTrue(fake.sent.every((value) => value.method === "GET"));
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("keeps rate-limit details safe and carries Retry-After into both adapters", () => {
    const fake = harness({
      "GET /auth/principal": new Response(
        JSON.stringify({ detail: "secret native data".repeat(200) }),
        { status: 429, headers: { "retry-after": "17" } },
      ),
    });
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.getViewer(target).pipe(Effect.flip);
      assert.strictEqual(error.detail, "GitCafe answered HTTP 429.");
      assert.strictEqual(error.reason, "rate-limited");
      assert.strictEqual(error.retryAt, now + 17_000);
      const prs = yield* GitCafePullRequestProvider.make;
      const prError = yield* prs
        .getViewer({ cwd: target.cwd, host: target.host })
        .pipe(Effect.flip);
      assert.strictEqual(prError.retryAt, error.retryAt);
      assert.strictEqual(prError.detail, error.detail);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("invalidates a rejected credential once and stops without retrying", () => {
    const fake = harness({ [`GET ${base}`]: new Response("raw private content", { status: 401 }) });
    return Effect.gen(function* () {
      const api = yield* GitCafeIssueTracker.make;
      const error = yield* api.getIssue(target).pipe(Effect.flip);
      assert.strictEqual(error.reason, "unauthenticated");
      assert.deepStrictEqual(fake.invalidated, ["git.cafe"]);
      assert.strictEqual(fake.sent.length, 1);
      assert.notInclude(error.detail, "private content");
    }).pipe(Effect.provide(fake.layer));
  });
  it.effect(
    "reads native detail, comment permissions and unknown comment count in five requests",
    () => {
      const fake = harness();
      return Effect.gen(function* () {
        const api = yield* GitCafeIssueTracker.make;
        const detail = yield* api.getIssue(target);
        assert.strictEqual(detail.key, "7");
        assert.strictEqual(detail.state.name, "triage");
        assert.strictEqual(detail.commentCount, null);
        assert.strictEqual(detail.viewer, "alice");
        assert.strictEqual(detail.comments[0]?.canEdit, true);
        assert.strictEqual(detail.commentsCursor, null);
        assert.deepStrictEqual(detail.events, []);
        assert.strictEqual(api.capabilities.templates, true);
        assert.strictEqual(api.capabilities.events, false);
        assert.deepStrictEqual(api.capabilities.involvements, ["all", "assigned", "authored"]);
        assert.deepStrictEqual(api.capabilities.listSorts, ["created", "updated"]);
        assert.strictEqual(fake.sent.length, 5);
      }).pipe(Effect.provide(fake.layer));
    },
  );
});
