import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { makeThreadProjectionFixture } from "./test-fixtures";

import {
  isThreadRoutePathname,
  isThreadRouteSnapshotAuthoritative,
  resolveActiveThreadRouteRef,
  resolveThreadRouteRenderState,
  resolveThreadRouteTarget,
} from "./threadRoutes";

describe("threadRoutes", () => {
  it("matches only the thread's own route pathname", () => {
    const ref = scopeThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(isThreadRoutePathname("/env-1/thread-1", ref)).toBe(true);
    expect(isThreadRoutePathname("/env-1/thread-1/", ref)).toBe(true);
    expect(isThreadRoutePathname("/new", ref)).toBe(false);
    expect(isThreadRoutePathname("/env-1/thread-2", ref)).toBe(false);
    expect(isThreadRoutePathname("/env-2/thread-1", ref)).toBe(false);
    expect(isThreadRoutePathname("/draft/thread-1", ref)).toBe(false);
    expect(isThreadRoutePathname("/env-1/thread-1/extra", ref)).toBe(false);
  });

  it("resolves the backing thread while a draft route is being promoted", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: scopeThreadRef("env-2" as never, ThreadId.make("server-thread")),
      }),
    ).toEqual({
      environmentId: "env-2",
      threadId: "server-thread",
    });
  });

  it("does not treat a draft's reserved thread ref as an active sidebar thread", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: null,
      }),
    ).toBeNull();
  });

  it.each([
    { status: "cached", source: "server thread" },
    { status: "synchronizing", source: "server thread" },
    { status: "cached", source: "draft" },
    { status: "synchronizing", source: "draft" },
  ] as const)(
    "keeps available $source visible while the shell is $status",
    ({ status, source }) => {
      expect(
        resolveThreadRouteRenderState({
          bootstrapComplete: isThreadRouteSnapshotAuthoritative(status),
          serverThreadExists: source === "server thread",
          serverThreadDeleted: false,
          unlistedThreadDetail: EMPTY_ENVIRONMENT_THREAD_STATE,
          draftThreadExists: source === "draft",
        }),
      ).toBe("ready");
    },
  );

  it("distinguishes bootstrap loading from a missing thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: false,
        serverThreadExists: false,
        serverThreadDeleted: false,
        unlistedThreadDetail: { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "deleted" },
        draftThreadExists: false,
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        unlistedThreadDetail: { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "deleted" },
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("opens an unlisted server thread once its detail arrives, without waiting for the shell", () => {
    const route = {
      bootstrapComplete: isThreadRouteSnapshotAuthoritative("live"),
      serverThreadExists: false,
      serverThreadDeleted: false,
      draftThreadExists: false,
    };

    expect(
      resolveThreadRouteRenderState({
        ...route,
        unlistedThreadDetail: EMPTY_ENVIRONMENT_THREAD_STATE,
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        ...route,
        unlistedThreadDetail: {
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          status: "synchronizing",
        },
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        ...route,
        unlistedThreadDetail: {
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          status: "synchronizing",
          error: Option.some("Connection interrupted"),
        },
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        ...route,
        unlistedThreadDetail: {
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          status: "live",
          data: Option.some(makeThreadProjectionFixture()),
        },
      }),
    ).toBe("ready");
  });

  it.each(["missing", "deleted", "archived"] as const)(
    "redirects an unlisted thread only after detail confirms it is %s",
    (outcome) => {
      const route = {
        bootstrapComplete: isThreadRouteSnapshotAuthoritative("live"),
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
      };
      expect(
        resolveThreadRouteRenderState({
          ...route,
          unlistedThreadDetail: {
            ...EMPTY_ENVIRONMENT_THREAD_STATE,
            status: "synchronizing",
          },
        }),
      ).toBe("loading");

      const projection = makeThreadProjectionFixture();
      const removedAt = DateTime.makeUnsafe("2026-01-02T00:00:00Z");
      expect(
        resolveThreadRouteRenderState({
          ...route,
          unlistedThreadDetail:
            outcome === "missing"
              ? { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "deleted" }
              : {
                  ...EMPTY_ENVIRONMENT_THREAD_STATE,
                  status: "live",
                  data: Option.some({
                    ...projection,
                    thread: {
                      ...projection.thread,
                      deletedAt: outcome === "deleted" ? removedAt : null,
                      archivedAt: outcome === "archived" ? removedAt : null,
                    },
                  }),
                },
        }),
      ).toBe("missing");
    },
  );

  it("waits for the live shell before redirecting a deleted thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: isThreadRouteSnapshotAuthoritative("cached"),
        serverThreadExists: true,
        serverThreadDeleted: true,
        unlistedThreadDetail: EMPTY_ENVIRONMENT_THREAD_STATE,
        draftThreadExists: false,
      }),
    ).toBe("loading");
  });
});
