import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveEagerActiveThreadRouteKey,
  resolveThreadRouteRenderState,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  shouldKeepActiveThreadVisitOnUnmount,
} from "./threadRoutes";

describe("threadRoutes", () => {
  it("builds canonical thread route params from a scoped ref", () => {
    const ref = scopeThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(buildThreadRouteParams(ref)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("resolves a scoped ref only when both params are present", () => {
    expect(
      resolveThreadRouteRef({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(resolveThreadRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveThreadRouteRef({ threadId: "thread-1" })).toBeNull();
  });

  it("builds canonical draft route params from a draft id", () => {
    expect(buildDraftThreadRouteParams(DraftId.make("draft-1"))).toEqual({
      draftId: "draft-1",
    });
  });

  it("resolves draft and server route targets", () => {
    expect(
      resolveThreadRouteTarget({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "server",
      threadRef: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
    });

    expect(
      resolveThreadRouteTarget({
        draftId: "draft-1",
      }),
    ).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });

    expect(resolveThreadRouteTarget({ environmentId: "env-1" })).toBeNull();
    expect(resolveThreadRouteTarget({ threadId: "thread-1" })).toBeNull();
  });

  it("eagerly tracks server routes before their thread detail mounts", () => {
    expect(
      resolveEagerActiveThreadRouteKey(
        resolveThreadRouteTarget({
          environmentId: "env-1",
          threadId: "thread-1",
        }),
      ),
    ).toBe("env-1:thread-1");
    expect(
      resolveEagerActiveThreadRouteKey(resolveThreadRouteTarget({ draftId: "draft-1" })),
    ).toBeUndefined();
    expect(resolveEagerActiveThreadRouteKey(null)).toBeNull();
  });

  it("keeps an active visit only while the same chat route remains mounted", () => {
    const routeThreadKey = "env-1:thread-1";

    expect(
      shouldKeepActiveThreadVisitOnUnmount({
        currentRouteTarget: resolveThreadRouteTarget({
          environmentId: "env-1",
          threadId: "thread-1",
        }),
        routeThreadKey,
        draftId: null,
      }),
    ).toBe(true);
    expect(
      shouldKeepActiveThreadVisitOnUnmount({
        currentRouteTarget: resolveThreadRouteTarget({
          environmentId: "env-1",
          threadId: "thread-2",
        }),
        routeThreadKey,
        draftId: null,
      }),
    ).toBe(false);
    expect(
      shouldKeepActiveThreadVisitOnUnmount({
        currentRouteTarget: resolveThreadRouteTarget({ draftId: "draft-1" }),
        routeThreadKey,
        draftId: DraftId.make("draft-1"),
      }),
    ).toBe(true);
    expect(
      shouldKeepActiveThreadVisitOnUnmount({
        currentRouteTarget: resolveThreadRouteTarget({ draftId: "draft-2" }),
        routeThreadKey,
        draftId: DraftId.make("draft-1"),
      }),
    ).toBe(false);
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

  it("keeps shell-only server threads in the loading state", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadShellExists: true,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("loading");
  });

  it("renders server details and local drafts when they are ready", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadShellExists: true,
        serverThreadDetailExists: true,
        serverThreadDetailDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadShellExists: false,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        draftThreadExists: true,
      }),
    ).toBe("ready");
  });

  it("distinguishes bootstrap loading from a missing thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: false,
        serverThreadShellExists: false,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadShellExists: false,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("redirects deleted shell-only threads", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadShellExists: true,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: true,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });
});
