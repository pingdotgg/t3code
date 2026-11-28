import { expect, it } from "@effect/vitest";
import type { VaultTokenService } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import { listConnectedItems, verifyServiceIdentity } from "./ServiceConnections.ts";

const token = "fixture-private-access-token";
const connection = (service: VaultTokenService) => ({
  service,
  token,
  account: "reader",
  revision: "v1",
});

// Inject an isolated fetch with no fallback, including on timeouts or unexpected URLs.
function run<A, E>(
  effect: Effect.Effect<A, E>,
  respond: (request: Request) => Response | Promise<Response>,
) {
  return effect.pipe(
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      Promise.resolve(respond(new Request(input, init))),
    ),
  );
}

it.effect(
  "verifies identity with each pinned service and reads only the approved category and count",
  () =>
    Effect.gen(function* () {
      for (const fixture of [
        {
          service: "github",
          account: "octo-test",
          identity: "https://api.github.com/user",
          profile: { login: "octo-test", email: "hidden@example.test" },
          list: "https://api.github.com/user/repos",
          params: { per_page: "1" },
          rows: [
            { full_name: "work/one", owner: { email: "hidden@example.test" } },
            { full_name: "work/two" },
          ],
          label: "work/one",
        },
        {
          service: "gitlab",
          account: "git.test",
          identity: "https://gitlab.com/api/v4/user",
          profile: { username: "git.test", email: "hidden@example.test" },
          list: "https://gitlab.com/api/v4/projects",
          params: { membership: "true", simple: "true", per_page: "1" },
          rows: [
            { path_with_namespace: "group/one", description: "private description" },
            { path_with_namespace: "group/two" },
          ],
          label: "group/one",
        },
        {
          service: "slack",
          account: "T123 / U123",
          identity: "https://slack.com/api/auth.test",
          profile: {
            ok: true,
            team_id: "T123",
            user_id: "U123",
            url: "https://workspace.example.test",
          },
          list: "https://slack.com/api/conversations.list",
          params: { types: "public_channel", exclude_archived: "true", limit: "1" },
          rows: {
            ok: true,
            channels: [
              { name: "private", is_channel: true, is_private: true },
              { name: "im", is_channel: false, is_private: true },
              { name: "archived", is_channel: true, is_private: false, is_archived: true },
              {
                name: "general",
                is_channel: true,
                is_private: false,
                topic: { value: "private topic" },
              },
            ],
          },
          label: "general",
        },
        {
          service: "airtable",
          account: "usrExample",
          identity: "https://api.airtable.com/v0/meta/whoami",
          profile: { id: "usrExample", email: "hidden@example.test" },
          list: "https://api.airtable.com/v0/meta/bases",
          params: {},
          rows: {
            bases: [{ name: "Inventory", permissionLevel: "create" }, { name: "Second" }],
            offset: token,
          },
          label: "Inventory",
        },
        {
          service: "asana",
          account: "12345678",
          identity: "https://app.asana.com/api/1.0/users/me?opt_fields=gid",
          profile: { data: { gid: "12345678", email: "hidden@example.test" } },
          list: "https://app.asana.com/api/1.0/workspaces",
          params: { opt_fields: "name", limit: "1" },
          rows: {
            data: [{ name: "Design", gid: "4" }, { name: "Second" }],
            next_page: { uri: token },
          },
          label: "Design",
        },
        {
          service: "linear",
          account: "cf69571f-7d21-4e5b-90e6-2730f51932f2",
          identity: "https://api.linear.app/graphql",
          identityBody: { query: "query Viewer { viewer { id } }" },
          profile: { data: { viewer: { id: "cf69571f-7d21-4e5b-90e6-2730f51932f2" } } },
          list: "https://api.linear.app/graphql",
          params: {},
          listBody: {
            query: "query Teams($first: Int!) { teams(first: $first) { nodes { name } } }",
            variables: { first: 1 },
          },
          rows: {
            data: { teams: { nodes: [{ name: "Engineering", key: "ENG" }, { name: "Second" }] } },
          },
          label: "Engineering",
        },
        {
          service: "netlify",
          account: "netlify-user-id",
          identity: "https://api.netlify.com/api/v1/user",
          profile: { id: "netlify-user-id", email: "hidden@example.test" },
          list: "https://api.netlify.com/api/v1/sites",
          params: { per_page: "1" },
          rows: [{ name: "docs-preview", password: token }, { name: "Second" }],
          label: "docs-preview",
        },
        {
          service: "notion",
          account: "notion-bot-id",
          identity: "https://api.notion.com/v1/users/me",
          profile: {
            object: "user",
            type: "bot",
            id: "notion-bot-id",
            bot: { owner: { email: token } },
          },
          list: "https://api.notion.com/v1/search",
          params: { filter_properties: "title" },
          listBody: { filter: { property: "object", value: "page" }, page_size: 1 },
          rows: {
            results: [
              { object: "data_source", title: [{ plain_text: "Excluded" }] },
              {
                object: "page",
                properties: {
                  Notes: { type: "rich_text", rich_text: [{ plain_text: token }] },
                  Name: {
                    type: "title",
                    id: "title",
                    title: [{ plain_text: "Team " }, { plain_text: "notes", href: token }],
                  },
                },
              },
              { object: "page" },
            ],
            has_more: true,
            next_cursor: token,
          },
          label: "Team notes",
        },
        {
          service: "todoist",
          account: "128118",
          identity: "https://api.todoist.com/api/v1/user",
          profile: { id: "128118", email: "hidden@example.test", token },
          list: "https://api.todoist.com/api/v1/projects",
          params: { limit: "1" },
          rows: {
            results: [{ name: "Weekend", description: token }, { name: "Second" }],
            next_cursor: token,
          },
          label: "Weekend",
        },
        {
          service: "typeform",
          account: "Survey editor",
          identity: "https://api.typeform.com/me",
          profile: { alias: "Survey editor", email: "hidden@example.test", language: "en" },
          list: "https://api.typeform.com/forms",
          params: { page_size: "1" },
          rows: {
            items: [{ title: "Suggestions", _links: { responses: token } }, { title: "Second" }],
            page_count: 2,
          },
          label: "Suggestions",
        },
        {
          service: "vercel",
          account: "Project access verified",
          identity: "https://api.vercel.com/v10/projects?limit=1",
          profile: { projects: [], pagination: { next: null, count: 0 } },
          list: "https://api.vercel.com/v10/projects",
          params: { limit: "1" },
          rows: { projects: [{ name: "storefront", env: [{ value: token }] }, { name: "Second" }] },
          label: "storefront",
        },
      ] as const) {
        let requests = 0;
        const respond = vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          expect(request.redirect).toBe("error");
          expect(request.credentials).toBe("omit");
          expect(request.cache).toBe("no-store");
          expect(request.headers.has("traceparent")).toBe(false);
          expect(request.url).not.toContain(token);
          expect(request.headers.get("authorization")).toBe(
            fixture.service === "linear" ? token : `Bearer ${token}`,
          );
          expect(request.headers.get("notion-version")).toBe(
            fixture.service === "notion" ? "2026-03-11" : null,
          );
          const identity = requests++ === 0;
          const body = identity
            ? "identityBody" in fixture && fixture.identityBody
            : "listBody" in fixture && fixture.listBody;
          expect(request.method).toBe(
            body || (identity && fixture.service === "slack") ? "POST" : "GET",
          );
          if (body) {
            expect(request.headers.get("content-type")).toMatch(/^application\/json\b/u);
            expect(await request.json()).toEqual(body);
          } else {
            expect(await request.text()).toBe("");
          }
          if (identity) {
            expect(request.url).toBe(fixture.identity);
            return Response.json(fixture.profile);
          }
          expect(`${url.origin}${url.pathname}`).toBe(fixture.list);
          expect(Object.fromEntries(url.searchParams)).toEqual(fixture.params);
          return Response.json(fixture.rows);
        });
        expect(yield* run(verifyServiceIdentity(fixture.service, token), respond)).toBe(
          fixture.account,
        );
        expect(
          yield* run(
            listConnectedItems(connection(fixture.service), { service: fixture.service, limit: 1 }),
            respond,
          ),
        ).toEqual([{ label: fixture.label }]);
        expect(respond).toHaveBeenCalledTimes(2);
      }
    }),
);

it.effect("rejects malformed responses and provider errors without exposing details", () =>
  Effect.gen(function* () {
    const services = [
      "airtable",
      "asana",
      "linear",
      "netlify",
      "notion",
      "todoist",
      "typeform",
      "vercel",
    ] as const;
    for (const service of services) {
      for (const response of [
        () => Response.json({ message: token }),
        () => Response.json({ message: token }, { status: 403 }),
      ]) {
        const verify = yield* run(Effect.flip(verifyServiceIdentity(service, token)), response);
        const list = yield* run(
          Effect.flip(listConnectedItems(connection(service), { service, limit: 1 })),
          response,
        );
        for (const error of [verify, list]) {
          expect(["authorization", "response"]).toContain(error.code);
          expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(token);
        }
      }
    }

    const partial = () =>
      Response.json({
        errors: [{ message: token }],
        data: { viewer: { id: "user" }, teams: { nodes: [{ name: "Do not return" }] } },
      });
    const verification = yield* run(Effect.flip(verifyServiceIdentity("linear", token)), partial);
    expect(verification.code).toBe("response");
    const list = listConnectedItems(connection("linear"), { service: "linear", limit: 2 });
    expect((yield* run(Effect.flip(list), partial)).code).toBe("response");
  }),
);

it.effect("checks bounded Notion rich text after joining and accepts an untitled page", () =>
  Effect.gen(function* () {
    const pages = (parts: readonly unknown[]) =>
      Response.json({
        results: [
          { object: "page", properties: { title: { id: "title", type: "title", title: parts } } },
        ],
      });
    const list = listConnectedItems(connection("notion"), { service: "notion", limit: 2 });
    for (const parts of [
      [{ plain_text: token.slice(0, 5) }, { plain_text: token.slice(5) }],
      [{ plain_text: "x".repeat(250) }, { plain_text: "x".repeat(7) }],
      [{ text: { content: "Unprojected" } }],
      [{ plain_text: "bad\u202elabel" }],
    ]) {
      expect((yield* run(Effect.flip(list), () => pages(parts))).code).toBe("response");
    }
    expect(yield* run(list, () => pages([]))).toEqual([{ label: "Untitled" }]);
  }),
);

it.effect("validates Vercel project access without disclosing the verification row", () =>
  Effect.gen(function* () {
    const profile = () => Response.json([{ id: "prj_fixture", name: token }]);
    expect(yield* run(verifyServiceIdentity("vercel", token), profile)).toBe(
      "Project access verified",
    );
    const malformed = () => Response.json({ projects: [null] });
    expect((yield* run(Effect.flip(verifyServiceIdentity("vercel", token)), malformed)).code).toBe(
      "response",
    );
  }),
);

it.effect(
  "rejects mismatched service, invalid operation limits and invalid tokens before any request",
  () =>
    Effect.gen(function* () {
      const respond = vi.fn(() => new Response(null, { status: 500 }));
      for (const operation of [
        { service: "gitlab", limit: 1 },
        { service: "slack", limit: 1 },
        { service: "github", limit: 0 },
        { service: "github", limit: 21 },
        { service: "github", limit: 1.5 },
      ] as const) {
        expect(
          (yield* run(Effect.flip(listConnectedItems(connection("github"), operation)), respond))
            .code,
        ).toBe("operation");
      }
      for (const invalid of ["", "bad\r\nheader", "x".repeat(4097)])
        expect(
          (yield* run(Effect.flip(verifyServiceIdentity("github", invalid)), respond)).code,
        ).toBe("authorization");
      expect(respond).not.toHaveBeenCalled();
    }),
);

it.effect(
  "rejects redirects, service errors, malformed JSON, and credential reflection without returning private details",
  () =>
    Effect.gen(function* () {
      for (const reply of [
        () =>
          new Response(token, {
            status: 302,
            headers: { location: `https://other.example.test/${token}` },
          }),
        () => new Response(token, { status: 401 }),
        () => new Response(token, { status: 502 }),
        () => Response.json({ ok: false, error: token }),
        () => new Response(token),
        () => {
          throw new Error(token);
        },
      ]) {
        const respond = vi.fn(reply);
        const failures = yield* Effect.all([
          run(Effect.flip(verifyServiceIdentity("slack", token)), respond),
          run(
            Effect.flip(listConnectedItems(connection("slack"), { service: "slack", limit: 1 })),
            respond,
          ),
        ]);
        for (const failure of failures) {
          expect(`${failure.message} ${JSON.stringify(failure)}`).not.toContain(token);
        }
        expect(respond).toHaveBeenCalledTimes(2);
      }
      expect(
        (yield* run(Effect.flip(verifyServiceIdentity("github", token)), () =>
          Response.json({ login: token }),
        )).code,
      ).toBe("response");
      expect(
        (yield* run(
          Effect.flip(listConnectedItems(connection("gitlab"), { service: "gitlab", limit: 1 })),
          () => Response.json([{ path_with_namespace: `group/${token}` }]),
        )).code,
      ).toBe("response");
    }),
);

it.effect("caps decoded bytes without Content-Length and cancels the unread stream", () =>
  Effect.gen(function* () {
    const cancel = vi.fn();
    const failure = yield* run(
      Effect.flip(verifyServiceIdentity("github", token)),
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(512 * 1024 + 1));
            },
            cancel,
          }),
        ),
    );
    expect(failure.code).toBe("response");
    expect(cancel).toHaveBeenCalledOnce();
  }),
);

it.effect("aborts an outstanding request when the private operation is cancelled", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<AbortSignal>();
    const pending = yield* verifyServiceIdentity("gitlab", token).pipe(
      Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
        const { signal } = new Request(input, init);
        started.resolve(signal);
        const response = Promise.withResolvers<Response>();
        signal.addEventListener("abort", () => response.reject(new Error(token)), { once: true });
        return response.promise;
      }),
      Effect.forkChild,
    );
    const requestSignal = yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(pending);
    expect(requestSignal.aborted).toBe(true);
  }),
);

it.effect("times out and aborts an unresponsive identity server", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<AbortSignal>();
    const pending = yield* verifyServiceIdentity("github", token).pipe(
      Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
        const { signal } = new Request(input, init);
        const response = Promise.withResolvers<Response>();
        signal.addEventListener("abort", () => response.reject(new Error("aborted")), {
          once: true,
        });
        started.resolve(signal);
        return response.promise;
      }),
      Effect.flip,
      Effect.forkChild,
    );
    const signal = yield* Effect.promise(() => started.promise);
    yield* TestClock.adjust("16 seconds");
    expect((yield* Fiber.join(pending)).code).toBe("timeout");
    expect(signal.aborted).toBe(true);
  }),
);
