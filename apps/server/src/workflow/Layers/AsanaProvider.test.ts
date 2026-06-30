import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { AsanaProvider as AsanaProviderTag } from "../Services/WorkSourceProvider.ts";
import { WorkSourceConnectionStore } from "../Services/WorkSourceConnectionStore.ts";
import { AsanaProviderLive } from "./AsanaProvider.ts";

// ---------------------------------------------------------------------------
// Canned Asana API responses
// ---------------------------------------------------------------------------

/** Task 1: open/incomplete */
const taskOpen = {
  gid: "task-gid-1",
  name: "Fix the bug",
  notes: "Detailed description here",
  completed: false,
  completed_at: null,
  assignee: { name: "Alice" },
  tags: [{ name: "urgent" }, { name: "backend" }],
  permalink_url: "https://app.asana.com/0/project/task-gid-1",
  modified_at: "2024-02-01T10:00:00.000Z",
};

/** Task 2: completed */
const taskCompleted = {
  gid: "task-gid-2",
  name: "Write the docs",
  notes: null,
  completed: true,
  completed_at: "2024-02-02T12:00:00.000Z",
  assignee: null,
  tags: [],
  permalink_url: "https://app.asana.com/0/project/task-gid-2",
  modified_at: "2024-02-02T12:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Helper: build a test layer with mocked HttpClient + connection store
// ---------------------------------------------------------------------------

function makeTestLayer(input: {
  readonly responseBody: unknown;
  readonly responseStatus?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly pat?: string;
}) {
  const pat = input.pat ?? "test-asana-pat";
  const status = input.responseStatus ?? 200;
  const headers = input.responseHeaders ?? {};

  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(input.responseBody), {
          status,
          headers: {
            "content-type": "application/json",
            ...headers,
          },
        }),
      ),
    ),
  );

  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => execute(request)),
  );

  const connectionStoreLayer = Layer.succeed(WorkSourceConnectionStore, {
    getToken: (_connectionRef, _expectedProvider) => Effect.succeed(pat),
    getConnectionAuth: (_connectionRef, _expectedProvider) =>
      Effect.succeed({ token: pat, authMode: "pat", baseUrl: null, email: null }),
    create: (_input) => Effect.die("not needed in test"),
    list: () => Effect.die("not needed in test"),
    remove: (_connectionRef) => Effect.die("not needed in test"),
  });

  const testLayer = AsanaProviderLive.pipe(
    Layer.provide(httpClientLayer),
    Layer.provide(connectionStoreLayer),
  );

  return { execute, testLayer };
}

// Helper: a canned page response wrapping tasks
function pageResponse(
  tasks: unknown[],
  nextOffset?: string,
): { data: unknown[]; next_page: unknown } {
  return {
    data: tasks,
    next_page: nextOffset
      ? { offset: nextOffset, path: "/tasks?offset=" + nextOffset, uri: "https://app.asana.com" }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AsanaProvider", () => {
  describe("listPage", () => {
    it.effect("maps incomplete task → open lifecycle, completed → closed lifecycle", () => {
      const { testLayer } = makeTestLayer({
        responseBody: pageResponse([taskOpen, taskCompleted]),
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { projectGid: "proj-123" },
          pageSize: 50,
        });

        expect(page.items).toHaveLength(2);

        // Task 1: open
        expect(page.items[0]!.externalId).toBe("task-gid-1");
        expect(page.items[0]!.lifecycle).toBe("open");
        expect(page.items[0]!.provider).toBe("asana");

        // Task 2: completed → closed
        expect(page.items[1]!.externalId).toBe("task-gid-2");
        expect(page.items[1]!.lifecycle).toBe("closed");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect(
      "maps fields: name→title, notes→description, assignee.name→assignees, tags→labels, permalink_url→url",
      () => {
        const { testLayer } = makeTestLayer({
          responseBody: pageResponse([taskOpen]),
        });

        return Effect.gen(function* () {
          const provider = yield* AsanaProviderTag;
          const page = yield* provider.listPage({
            connectionRef: "conn",
            selector: { projectGid: "proj-123" },
            pageSize: 50,
          });

          const item = page.items[0]!;
          expect(item.fields.title).toBe("Fix the bug");
          expect(item.fields.description).toBe("Detailed description here");
          expect(item.fields.assignees).toEqual(["Alice"]);
          expect(item.fields.labels).toEqual(["urgent", "backend"]);
          expect(item.url).toBe("https://app.asana.com/0/project/task-gid-1");
          expect(item.version.updatedAt).toBe("2024-02-01T10:00:00.000Z");
        }).pipe(Effect.provide(testLayer));
      },
    );

    it.effect("task with null notes → description undefined", () => {
      const { testLayer } = makeTestLayer({
        responseBody: pageResponse([taskCompleted]),
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { projectGid: "proj-123" },
          pageSize: 50,
        });

        expect(page.items[0]!.fields.description).toBeUndefined();
        // No assignee → assignees undefined
        expect(page.items[0]!.fields.assignees).toBeUndefined();
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("pagination: next_page.offset becomes nextPageToken when present", () => {
      const { testLayer } = makeTestLayer({
        responseBody: pageResponse([taskOpen], "PAGE_TOKEN_ABC"),
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { projectGid: "proj-123" },
          pageSize: 10,
        });
        expect(page.nextPageToken).toBe("PAGE_TOKEN_ABC");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("pagination: null next_page → nextPageToken undefined", () => {
      const { testLayer } = makeTestLayer({
        responseBody: pageResponse([taskOpen]),
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { projectGid: "proj-123" },
          pageSize: 10,
        });
        expect(page.nextPageToken).toBeUndefined();
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("includeCompleted:false adds completed_since=now to the request", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: pageResponse([taskOpen]),
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        yield* provider.listPage({
          connectionRef: "conn",
          selector: { projectGid: "proj-123", includeCompleted: false },
          pageSize: 20,
        });

        const request = execute.mock.calls[0]?.[0];
        expect(request).toBeDefined();
        // urlParams is a UrlParams object with a .params ReadonlyArray
        const params: ReadonlyArray<readonly [string, string]> = request!.urlParams.params;
        const completedSinceParam = params.find(([k]) => k === "completed_since");
        expect(completedSinceParam).toBeDefined();
        expect(completedSinceParam![1]).toBe("now");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("includeCompleted:true (default) does NOT add completed_since", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: pageResponse([taskOpen]),
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        yield* provider.listPage({
          connectionRef: "conn",
          // Omit includeCompleted — defaults to true
          selector: { projectGid: "proj-123" },
          pageSize: 20,
        });

        const request = execute.mock.calls[0]?.[0];
        expect(request).toBeDefined();
        const params: ReadonlyArray<readonly [string, string]> = request!.urlParams.params;
        const completedSinceParam = params.find(([k]) => k === "completed_since");
        expect(completedSinceParam).toBeUndefined();
      }).pipe(Effect.provide(testLayer));
    });

    it.effect(
      "sectionGid/tagGid set → still returns full mapped page (warning is non-fatal)",
      () => {
        const { testLayer } = makeTestLayer({
          responseBody: pageResponse([taskOpen, taskCompleted]),
        });

        return Effect.gen(function* () {
          const provider = yield* AsanaProviderTag;
          const page = yield* provider.listPage({
            connectionRef: "conn",
            // sectionGid/tagGid set — v1 does NOT filter; warning emitted but behavior unchanged
            selector: { projectGid: "proj-123", sectionGid: "sect-1", tagGid: "tag-1" },
            pageSize: 50,
          });

          // Full project page returned, not filtered down
          expect(page.items.map((i) => i.externalId)).toEqual(["task-gid-1", "task-gid-2"]);
        }).pipe(Effect.provide(testLayer));
      },
    );

    it.effect("429 + Retry-After:2 → WorkSourceRateLimitError{retryAfterMs:2000}", () => {
      // it.effect uses an internal test clock pinned at epoch 0 — the
      // Asana 429 path reads Retry-After in seconds and multiplies by 1000,
      // so Retry-After:2 → retryAfterMs:2000 deterministically.
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "Rate Limited" }] },
        responseStatus: 429,
        responseHeaders: { "retry-after": "2" },
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "conn",
            selector: { projectGid: "proj-123" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceRateLimitError");
        expect((failure as { retryAfterMs?: number }).retryAfterMs).toBe(2000);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("429 without Retry-After → WorkSourceRateLimitError with fallback 60_000ms", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "Rate Limited" }] },
        responseStatus: 429,
        responseHeaders: {},
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "conn",
            selector: { projectGid: "proj-123" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceRateLimitError");
        expect((failure as { retryAfterMs?: number }).retryAfterMs).toBe(60_000);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("401 → WorkSourceAuthError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "Not Authorized" }] },
        responseStatus: 401,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "my-conn",
            selector: { projectGid: "proj-123" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceAuthError");
        expect((failure as { connectionRef?: string }).connectionRef).toBe("my-conn");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("403 (PAT lacks project access) → WorkSourceAuthError (NOT transient)", () => {
      // Fix L5: an Asana 403 from an authenticated PAT that lacks access to the
      // project is a stable permission failure → auth, not transient backoff.
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "Forbidden" }] },
        responseStatus: 403,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "scoped-conn",
            selector: { projectGid: "proj-123" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceAuthError");
        expect((failure as { connectionRef?: string }).connectionRef).toBe("scoped-conn");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("invalid selector → WorkSourceConfigError", () => {
      const { testLayer } = makeTestLayer({ responseBody: pageResponse([]) });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "conn",
            // missing required projectGid
            selector: { includeCompleted: false },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceConfigError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("sends Authorization header with PAT", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: pageResponse([]),
        pat: "secret-asana-pat-xyz",
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        yield* provider.listPage({
          connectionRef: "conn",
          selector: { projectGid: "proj-999" },
          pageSize: 10,
        });

        const request = execute.mock.calls[0]?.[0];
        expect(request).toBeDefined();
        expect(request!.headers["authorization"]).toBe("Bearer secret-asana-pat-xyz");
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("getItem", () => {
    it.effect("returns a mapped ExternalWorkItem for an existing task gid", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { data: taskOpen },
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const item = yield* provider.getItem({
          connectionRef: "conn",
          selector: { projectGid: "p" },
          externalId: "task-gid-1",
        });

        expect(item).not.toBeNull();
        expect(item!.externalId).toBe("task-gid-1");
        expect(item!.lifecycle).toBe("open");
        expect(item!.fields.title).toBe("Fix the bug");
        expect(item!.fields.description).toBe("Detailed description here");
        expect(item!.fields.assignees).toEqual(["Alice"]);
        expect(item!.fields.labels).toEqual(["urgent", "backend"]);
        expect(item!.url).toBe("https://app.asana.com/0/project/task-gid-1");
        expect(item!.provider).toBe("asana");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("returns null when getItem receives a 404 (task deleted)", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "task: Not a recognized ID" }] },
        responseStatus: 404,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const result = yield* provider.getItem({
          connectionRef: "conn",
          selector: { projectGid: "p" },
          externalId: "nonexistent-gid",
        });
        expect(result).toBeNull();
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("getItem 401 → WorkSourceAuthError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "Not Authorized" }] },
        responseStatus: 401,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* Effect.flip(
          provider.getItem({
            connectionRef: "bad-conn",
            selector: { projectGid: "p" },
            externalId: "some-gid",
          }),
        );
        expect(failure._tag).toBe("WorkSourceAuthError");
        expect((failure as { connectionRef?: string }).connectionRef).toBe("bad-conn");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("getItem 403 → WorkSourceAuthError (NOT transient)", () => {
      // Fix L5: 403 in getItem is a stable permission failure, not transient.
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "Forbidden" }] },
        responseStatus: 403,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* Effect.flip(
          provider.getItem({
            connectionRef: "scoped-conn",
            selector: { projectGid: "p" },
            externalId: "some-gid",
          }),
        );
        expect(failure._tag).toBe("WorkSourceAuthError");
        expect((failure as { connectionRef?: string }).connectionRef).toBe("scoped-conn");
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("Fix 6: malformed response body → WorkSourceTransientError (not a defect)", () => {
    it.effect("listPage: 200 body missing the data array → WorkSourceTransientError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { not_data: "garbage" },
        responseStatus: 200,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* provider
          .listPage({ connectionRef: "conn", selector: { projectGid: "p" }, pageSize: 100 })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("WorkSourceTransientError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("listPage: 200 body where data is not an array → WorkSourceTransientError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { data: "not-an-array" },
        responseStatus: 200,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* provider
          .listPage({ connectionRef: "conn", selector: { projectGid: "p" }, pageSize: 100 })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("WorkSourceTransientError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("getItem: 200 body missing the data object → WorkSourceTransientError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { not_data: "garbage" },
        responseStatus: 200,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const failure = yield* provider
          .getItem({ connectionRef: "conn", selector: { projectGid: "p" }, externalId: "g" })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("WorkSourceTransientError");
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("AsanaProvider import methods", () => {
    it.effect("toImportableView uses empty displayRef + projectGid as container", () => {
      const { testLayer } = makeTestLayer({ responseBody: pageResponse([]) });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const parts = provider.toImportableView({
          selector: { projectGid: "111", includeCompleted: false },
          item: {
            provider: "asana",
            externalId: "task-gid-1",
            url: "https://app.asana.com/0/111/task-gid-1",
            lifecycle: "open",
            version: {},
            fields: { title: "task" },
          },
        });
        assert.equal(parts.displayRef, "");
        assert.equal(parts.container, "111");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("toImportableView falls back to 'Asana' when projectGid is absent", () => {
      const { testLayer } = makeTestLayer({ responseBody: pageResponse([]) });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const parts = provider.toImportableView({
          selector: {},
          item: {
            provider: "asana",
            externalId: "task-gid-2",
            url: "https://app.asana.com/0/0/task-gid-2",
            lifecycle: "open",
            version: {},
            fields: { title: "task" },
          },
        });
        assert.equal(parts.displayRef, "");
        assert.equal(parts.container, "Asana");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("viewer returns the user's gid + display name alias", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { data: { gid: "me-gid", name: "Jo" } },
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const v = yield* provider.viewer({ connectionRef: "c" });
        assert.deepEqual(v, { id: "me-gid", aliases: ["Jo"] });
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("viewer returns null on non-200 status", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { errors: [{ message: "Not Authorized" }] },
        responseStatus: 401,
      });

      return Effect.gen(function* () {
        const provider = yield* AsanaProviderTag;
        const v = yield* provider.viewer({ connectionRef: "c" });
        assert.equal(v, null);
      }).pipe(Effect.provide(testLayer));
    });
  });
});
