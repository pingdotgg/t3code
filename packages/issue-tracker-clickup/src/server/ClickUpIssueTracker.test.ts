import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import { parseClickUpIssueUrl } from "../shared/issueUrl.ts";
import * as ClickUpApi from "./ClickUpApi.ts";
import * as ClickUpIssueTracker from "./ClickUpIssueTracker.ts";

const user = (id: number, username: string) => ({
  id,
  username,
  email: `${username}@acme.test`,
  profilePicture: null,
});
const JULIUS = user(1, "julius");
const THEO = user(2, "theo");

const TODO = { status: "to do", type: "open", orderindex: 0 };
const DOING = { status: "in progress", type: "custom", orderindex: 1 };
const DONE = { status: "complete", type: "done", orderindex: 2 };

const task = (id: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  id,
  custom_id: null,
  name: `Task ${id}`,
  url: `https://app.clickup.com/t/${id}`,
  status: TODO,
  date_created: "1782864000000",
  date_updated: "1782950400000",
  date_closed: null,
  date_done: null,
  creator: JULIUS,
  assignees: [THEO],
  watchers: [],
  tags: [{ name: "bug", tag_bg: "#f00" }],
  list: { id: "900" },
  markdown_description: "**body**",
  ...overrides,
});

const comment = (id: string, date: number) => ({
  id,
  comment_text: `comment ${id}`,
  user: JULIUS,
  date: String(date),
});

type Answer = (request: { readonly url: URL; readonly body: unknown }) => unknown;

/** Answers each REST call by `METHOD /path`, the way ClickUp would. */
function fakeClickUp(answers: Record<string, Answer>, stored: string | null = "pk_stored") {
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly url: URL;
    readonly body: unknown;
    readonly authorization: string | undefined;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        for (const [name, value] of request.urlParams)
          url.searchParams.append(name, Redacted.isRedacted(value) ? Redacted.value(value) : value);
        const path = url.pathname.replace(/^\/api\/v2/, "");
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;
        requests.push({
          method: request.method,
          path,
          url,
          body,
          authorization: request.headers.authorization,
        });
        const answer = answers[`${request.method} ${path}`];
        const answered = answer?.({ url, body });
        const response =
          answered instanceof Response
            ? answered
            : new Response(JSON.stringify(answer === undefined ? { err: "No route" } : answered), {
                status: answer === undefined ? 404 : 200,
                headers: { "content-type": "application/json" },
              });
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.succeed(Option.fromNullishOr(stored)) },
    }),
  );
  // Every optional method is implemented here; the type says so for the calls below.
  const tracker = ClickUpIssueTracker.make.pipe(
    Effect.map((api) => api as Required<StandaloneIssueTrackerApi>),
    Effect.provide(ClickUpApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { tracker, requests };
}

const target = { cwd: "/w/web", host: "app.clickup.com", scope: "900" };
const listing = {
  ...target,
  state: "open",
  involvement: "all",
  sort: "updated",
  limit: 50,
} as const;

const LIST = { id: "900", name: "Sprint", space: { id: "77" }, statuses: [DONE, TODO, DOING] };

describe("parseClickUpIssueUrl", () => {
  it("reads a task link and leaves anything else alone", () => {
    expect(parseClickUpIssueUrl(new URL("https://app.clickup.com/t/86c0abcd"))).toEqual({
      host: "app.clickup.com",
      workspace: "",
      scope: "task",
      key: "86c0abcd",
    });
    expect(parseClickUpIssueUrl(new URL("https://app.clickup.com/t/86c0abcd//x"))).toBeNull();
    expect(parseClickUpIssueUrl(new URL("https://app.clickup.com/t/9015/DEV-12"))).toBeNull();
    expect(parseClickUpIssueUrl(new URL("https://app.clickup.com/9015/v/li/900"))).toBeNull();
    expect(parseClickUpIssueUrl(new URL("https://evil.test/t/86c0abcd"))).toBeNull();
  });
});

describe("ClickUpIssueTracker", () => {
  it.effect("signs with the bare token and names every reachable list by where it sits", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /user": () => ({ user: JULIUS }),
        "GET /team": () => ({ teams: [{ id: "9015", name: "Acme" }] }),
        "GET /team/9015/space": () => ({ spaces: [{ id: "77", name: "Product" }] }),
        "GET /space/77/folder": () => ({
          folders: [{ id: "5", name: "Web", lists: [{ id: "900", name: "Sprint" }] }],
        }),
        "GET /space/77/list": () => ({ lists: [{ id: "901", name: "Inbox" }] }),
      });
      const api = yield* tracker;
      const probe = yield* api.probeCredential("pk_new");
      expect(probe).toEqual({
        account: "julius",
        workspace: "Acme",
        scopes: [
          { key: "901", name: "Product / Inbox" },
          { key: "900", name: "Product / Web / Sprint" },
        ],
      });
      expect(new Set(requests.map((request) => request.authorization))).toEqual(
        new Set(["pk_new"]),
      );
    }),
  );

  it.effect("reports a refused token as unauthenticated and a rate limit with its reset", () =>
    Effect.gen(function* () {
      const { tracker } = fakeClickUp({
        "GET /user": () =>
          new Response(JSON.stringify({ err: "Token invalid", ECODE: "OAUTH_025" }), {
            status: 401,
          }),
        "GET /list/900/task": () =>
          new Response(JSON.stringify({ err: "Rate limit reached" }), {
            status: 429,
            headers: { "x-ratelimit-reset": "4102444800" },
          }),
      });
      const api = yield* tracker;
      const refused = yield* Effect.flip(api.getViewer(target));
      expect(refused.reason).toBe("unauthenticated");
      const limited = yield* Effect.flip(api.listIssues(listing));
      expect(limited.reason).toBe("rate-limited");
      expect(limited.retryAt).toBe(4102444800000);
    }),
  );

  it.effect("slices ClickUp's hundred-task pages and keeps only open tasks", () =>
    Effect.gen(function* () {
      const pages: Array<string | null> = [];
      const { tracker } = fakeClickUp({
        "GET /list/900/task": ({ url }) => {
          pages.push(url.searchParams.get("page"));
          return {
            tasks: [
              task("a", { date_updated: "1782950400003" }),
              task("b", { date_updated: "1782950400002", status: DONE }),
              task("c", { date_updated: "1782950400001" }),
            ],
            last_page: false,
          };
        },
      });
      const api = yield* tracker;
      const first = yield* api.listIssues({ ...listing, limit: 1 });
      expect(first.items.map((item) => item.key)).toEqual(["a"]);
      expect(first.nextCursor).toBe("0:a");
      const second = yield* api.listIssues({ ...listing, limit: 1, cursor: first.nextCursor! });
      expect(second.items.map((item) => item.key)).toEqual(["c"]);
      expect(second.nextCursor).toBe("1:");
      expect(pages).toEqual(["0", "0"]);
      expect(first.items[0]).toMatchObject({
        displayKey: "#a",
        state: { category: "open", name: "to do" },
        assignees: [{ login: "theo" }],
        labels: [{ name: "bug", color: "#f00" }],
      });
    }),
  );

  it.effect("lists every task of a page once even when an update reorders it", () =>
    Effect.gen(function* () {
      let reads = 0;
      const { tracker } = fakeClickUp({
        "GET /list/900/task": () => {
          reads += 1;
          // After the first slice, B is updated and moves to the top of the page.
          const updatedB = reads === 1 ? "1782950400002" : "1782950400009";
          return {
            tasks: [
              task("a", { date_updated: "1782950400003" }),
              task("b", { date_updated: updatedB }),
              task("c", { date_updated: "1782950400001" }),
            ],
            last_page: true,
          };
        },
      });
      const api = yield* tracker;
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* api.listIssues({ ...listing, limit: 1, cursor });
        keys.push(...page.items.map((item) => item.key));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(keys).toEqual(["a", "b", "c"]);
    }),
  );

  it.effect("narrows assigned-to-me by the viewer's id", () =>
    Effect.gen(function* () {
      const asked: Array<string[]> = [];
      const { tracker } = fakeClickUp({
        "GET /user": () => ({ user: THEO }),
        "GET /list/900/task": ({ url }) => {
          asked.push(url.searchParams.getAll("assignees[]"));
          return { tasks: [task("a"), task("b", { assignees: [JULIUS] })], last_page: true };
        },
      });
      const api = yield* tracker;
      const page = yield* api.listIssues({ ...listing, involvement: "assigned", viewer: "theo" });
      expect(asked).toEqual([["2"]]);
      expect(page.items.map((item) => item.key)).toEqual(["a"]);
      expect(page.nextCursor).toBeNull();
    }),
  );

  it.effect("reads a task with its list's workflow and comments oldest first", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 25 }, (_, index) =>
        comment(`c${25 - index}`, 1782950400000 + 25 - index),
      );
      const { tracker } = fakeClickUp({
        "GET /task/abc": () => task("abc", { status: DOING }),
        "GET /task/abc/comment": () => ({ comments }),
        "GET /list/900": () => LIST,
        "GET /user": () => ({ user: JULIUS }),
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "abc" });
      expect(detail.body).toBe("**body**");
      expect(detail.viewer).toBe("julius");
      expect(detail.states.map((state) => state.name)).toEqual([
        "to do",
        "in progress",
        "complete",
      ]);
      expect(detail.states[2]).toEqual({
        category: "closed",
        name: "complete",
        closeReason: "completed",
      });
      expect(detail.comments[0]?.id).toBe("c1");
      expect(detail.comments.at(-1)?.id).toBe("c25");
      expect(detail.commentsCursor).toBe("1782950400001:c1");
    }),
  );

  it.effect("pages older comments from the oldest one, without repeating it", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /task/abc/comment": () => ({
          comments: [comment("c1", 100), comment("c0", 50)],
        }),
      });
      const api = yield* tracker;
      const page = yield* api.getComments({ ...target, key: "abc", cursor: "100:c1" });
      expect(page.comments.map((entry) => entry.id)).toEqual(["c0"]);
      expect(page.nextCursor).toBeNull();
      expect(requests[0]?.url.searchParams.get("start")).toBe("100");
      expect(requests[0]?.url.searchParams.get("start_id")).toBe("c1");
    }),
  );

  it.effect("rewrites tags one by one and assignees as a difference", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /task/abc": () => task("abc"),
        "GET /list/900": () => LIST,
        "GET /list/900/member": () => ({ members: [JULIUS, THEO] }),
        "GET /team": () => ({ teams: [] }),
        "GET /space/77/tag": () => ({ tags: [{ name: "bug" }, { name: "Feature" }] }),
        "PUT /task/abc": () => ({}),
        "POST /task/abc/tag/Feature": () => ({}),
        "DELETE /task/abc/tag/bug": () => ({}),
      });
      const api = yield* tracker;
      yield* api.update({ ...target, key: "abc", labels: ["feature"], assignees: ["julius"] });
      const writes = requests.filter((request) => request.method !== "GET");
      expect(writes.map((request) => `${request.method} ${request.path}`).toSorted()).toEqual([
        "DELETE /task/abc/tag/bug",
        "POST /task/abc/tag/Feature",
        "PUT /task/abc",
      ]);
      expect(writes.find((request) => request.method === "PUT")?.body).toEqual({
        assignees: { add: [1], rem: [2] },
      });
    }),
  );

  it.effect("moves a task only to a status its list has", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /task/abc": () => task("abc"),
        "GET /list/900": () => LIST,
        "PUT /task/abc": () => ({}),
      });
      const api = yield* tracker;
      const refused = yield* Effect.flip(api.setState({ ...target, key: "abc", state: "Shipped" }));
      expect(refused.detail).toBe("The status is not one this ClickUp list has.");
      yield* api.setState({ ...target, key: "abc", state: "Complete" });
      expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
        status: "complete",
      });
    }),
  );

  it.effect("files a task in the list with its tags and members", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /list/900": () => LIST,
        "GET /list/900/member": () => ({ members: [JULIUS, THEO] }),
        "GET /team": () => ({ teams: [] }),
        "GET /space/77/tag": () => ({ tags: [{ name: "bug" }] }),
        "POST /list/900/task": () => task("new1", { custom_id: "DEV-7" }),
      });
      const api = yield* tracker;
      const created = yield* api.create({
        ...target,
        title: "New",
        body: "Hello",
        labels: ["BUG"],
        assignees: ["theo@acme.test"],
      });
      expect(created).toEqual({
        key: "new1",
        displayKey: "DEV-7",
        url: "https://app.clickup.com/t/new1",
      });
      expect(requests.find((request) => request.method === "POST")?.body).toEqual({
        name: "New",
        markdown_content: "Hello",
        tags: ["bug"],
        assignees: [2],
      });
    }),
  );

  it.effect("refuses a write to a task that left the list it was placed in", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /task/abc": () => task("abc", { list: { id: "901" } }),
        "GET /list/900": () => LIST,
      });
      const api = yield* tracker;
      const ref = { ...target, key: "abc" };
      for (const write of [
        api.comment({ ...ref, body: "hi" }),
        api.update({ ...ref, title: "New" }),
        api.setState({ ...ref, state: "complete" }),
      ]) {
        const refused = yield* Effect.flip(write);
        expect(refused.detail).toContain("no longer in the selected ClickUp list");
      }
      expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    }),
  );

  it.effect("checks every requested value before writing any of them", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /task/abc": () => task("abc"),
        "GET /list/900": () => LIST,
        "GET /space/77/tag": () => ({ tags: [{ name: "bug" }] }),
      });
      const api = yield* tracker;
      const refused = yield* Effect.flip(
        api.update({ ...target, key: "abc", title: "Renamed", labels: ["missing"] }),
      );
      expect(refused.detail).toBe("A tag is not one this ClickUp space has.");
      expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    }),
  );

  it.effect("keeps a current assignee the list's members leave out", () =>
    Effect.gen(function* () {
      const OUTSIDER = user(9, "outsider");
      const { tracker, requests } = fakeClickUp({
        "GET /task/abc": () => task("abc", { assignees: [OUTSIDER] }),
        "PUT /task/abc": () => ({}),
      });
      const api = yield* tracker;
      yield* api.update({ ...target, key: "abc", assignees: ["outsider", "2"] });
      expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
        assignees: { add: [2], rem: [] },
      });
      expect(requests.some((request) => request.path.endsWith("/member"))).toBe(false);
    }),
  );

  it.effect("offers only what the account's permission level allows", () =>
    Effect.gen(function* () {
      const answers = (level: string) => ({
        "GET /task/abc": () => task("abc", { permission_level: level }),
        "GET /task/abc/comment": () => ({ comments: [] }),
        "GET /list/900": () => LIST,
        "GET /user": () => ({ user: JULIUS }),
      });
      const read = yield* (yield* fakeClickUp(answers("read")).tracker).getIssue({
        ...target,
        key: "abc",
      });
      expect(Object.values(read.viewerPermissions).every((granted) => !granted)).toBe(true);
      const comment = yield* (yield* fakeClickUp(answers("comment")).tracker).getIssue({
        ...target,
        key: "abc",
      });
      expect(comment.viewerPermissions).toMatchObject({ comment: true, edit: false });
    }),
  );

  it.effect("reads an id this account cannot see as not found", () =>
    Effect.gen(function* () {
      const { tracker } = fakeClickUp({
        "GET /task/abc": () =>
          new Response(JSON.stringify({ err: "Team not authorized", ECODE: "OAUTH_027" }), {
            status: 401,
          }),
      });
      const missing = yield* Effect.flip((yield* tracker).issueScope({ ...target, key: "abc" }));
      expect(missing.reason).toBe("not-found");
      expect(missing.detail).not.toContain("Team not authorized");
    }),
  );

  it.effect("checks the token on every probe but discovers lists once a while", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeClickUp({
        "GET /user": () => ({ user: JULIUS }),
        "GET /team": () => ({ teams: [] }),
      });
      const api = yield* tracker;
      yield* api.probeCredential("pk_new");
      yield* api.probeCredential("pk_new");
      expect(requests.map((request) => request.path)).toEqual(["/user", "/team", "/user"]);
    }),
  );

  it.effect("keeps paging comments when ClickUp repeats the cursor's own comment", () =>
    Effect.gen(function* () {
      const page = [
        comment("c26", 260),
        ...Array.from({ length: 24 }, (_, i) => comment(`c${25 - i}`, 250 - i)),
      ];
      const { tracker } = fakeClickUp({ "GET /task/abc/comment": () => ({ comments: page }) });
      const older = yield* (yield* tracker).getComments({
        ...target,
        key: "abc",
        cursor: "260:c26",
      });
      expect(older.comments).toHaveLength(24);
      expect(older.nextCursor).toBe("227:c2");
    }),
  );

  it.effect("asks ClickUp for a closed listing by the list's closed statuses", () =>
    Effect.gen(function* () {
      const asked: Array<string[]> = [];
      const { tracker } = fakeClickUp({
        "GET /list/900": () => LIST,
        "GET /list/900/task": ({ url }) => {
          asked.push(url.searchParams.getAll("statuses[]"));
          return { tasks: [task("a", { status: DONE })], last_page: true };
        },
      });
      const page = yield* (yield* tracker).listIssues({ ...listing, state: "closed" });
      expect(asked).toEqual([["complete"]]);
      expect(page.items[0]?.state).toEqual({
        category: "closed",
        name: "complete",
        closeReason: "completed",
      });
    }),
  );

  it.effect("assigns someone who reaches the list only through its workspace", () =>
    Effect.gen(function* () {
      const WIDE = user(7, "wide");
      const { tracker, requests } = fakeClickUp({
        "GET /task/abc": () => task("abc"),
        "GET /list/900/member": () => ({ members: [THEO] }),
        "GET /team": () => ({ teams: [{ id: "9015", name: "Acme", members: [{ user: WIDE }] }] }),
        "PUT /task/abc": () => ({}),
      });
      yield* (yield* tracker).update({ ...target, key: "abc", assignees: ["theo", "wide"] });
      expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
        assignees: { add: [7], rem: [] },
      });
    }),
  );

  it.effect("offers only the list's own workspace when the token reaches two", () =>
    Effect.gen(function* () {
      const { tracker } = fakeClickUp({
        "GET /list/900": () => LIST,
        "GET /list/900/member": () => ({ members: [] }),
        "GET /space/77/tag": () => ({ tags: [] }),
        "GET /team": () => ({
          teams: [
            { id: "1", name: "Other", members: [{ user: user(11, "alex") }] },
            { id: "2", name: "Acme", members: [{ user: user(22, "alex") }] },
          ],
        }),
        "GET /team/1/space": () => ({ spaces: [{ id: "55", name: "Elsewhere" }] }),
        "GET /team/2/space": () => ({ spaces: [{ id: "77", name: "Product" }] }),
      });
      const candidates = yield* (yield* tracker).listCandidates(target);
      expect(candidates.assignees.map((candidate) => candidate.id)).toEqual(["22"]);
    }),
  );

  it.effect("waits out a rate limit during discovery and keeps what it already read", () =>
    Effect.gen(function* () {
      let refused = false;
      const { tracker, requests } = fakeClickUp({
        "GET /user": () => ({ user: JULIUS }),
        "GET /team": () => ({ teams: [{ id: "9015", name: "Acme" }] }),
        "GET /team/9015/space": () => ({ spaces: [{ id: "77", name: "Product" }] }),
        "GET /space/77/folder": () => {
          if (refused) return { folders: [] };
          refused = true;
          return new Response(JSON.stringify({ err: "Rate limit reached" }), { status: 429 });
        },
        "GET /space/77/list": () => ({ lists: [{ id: "901", name: "Inbox" }] }),
      });
      const api = yield* tracker;
      const probing = yield* Effect.forkChild(api.probeCredential("pk_new"));
      yield* TestClock.adjust("65 seconds");
      const probe = yield* Fiber.join(probing);
      expect(probe.scopes).toEqual([{ key: "901", name: "Product / Inbox" }]);
      expect(requests.filter((request) => request.path === "/team/9015/space")).toHaveLength(1);
      expect(requests.filter((request) => request.path === "/space/77/folder")).toHaveLength(2);
    }),
  );

  it.effect("places a task by the list it is in", () =>
    Effect.gen(function* () {
      const { tracker } = fakeClickUp({
        "GET /task/abc": () => task("abc", { list: { id: "901" } }),
      });
      const api = yield* tracker;
      expect(yield* api.issueScope({ ...target, scope: "task", key: "abc" })).toBe("901");
    }),
  );
});
