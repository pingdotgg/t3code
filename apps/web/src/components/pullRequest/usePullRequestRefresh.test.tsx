import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { invalidate, notify } = vi.hoisted(() => ({ invalidate: vi.fn(), notify: vi.fn() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { invalidate: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => invalidate }));
vi.mock("../ui/toast", () => ({ toastManager: { add: notify } }));

import { LIVE_REFRESH_INTERVAL_MS } from "~/hooks/useLiveRefresh";
import { usePullRequestRefresh } from "./usePullRequestRefresh";

type Props = Parameters<typeof usePullRequestRefresh>[0];
const refreshMetadata = vi.fn();
const refreshActivity = vi.fn();
const refreshDetail = vi.fn();
let renderer: ReactTestRenderer | null;
let props: Props;
let testNumber = 0;

function PanelReads(input: Props) {
  const { refreshToken, isInvalidating, refreshFromHost } = usePullRequestRefresh(input);
  return (
    <>
      <output>{refreshToken}</output>
      <button disabled={isInvalidating} onClick={refreshFromHost}>
        Refresh
      </button>
    </>
  );
}

async function render(changes: Partial<Props> = {}) {
  props = { ...props, ...changes };
  await act(async () => {
    const panel = (
      <StrictMode>
        <PanelReads {...props} />
      </StrictMode>
    );
    if (renderer) renderer.update(panel);
    else renderer = create(panel);
  });
}

function diffRefreshes() {
  return renderer!.root.findByType("output").children.join("");
}

function invalidation() {
  let resolve!: (result: AtomCommandResult<void, Error>) => void;
  const promise = new Promise<AtomCommandResult<void, Error>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  invalidate.mockReturnValueOnce(promise);
  return {
    succeed: () => act(async () => resolve(AsyncResult.success(undefined))),
    fail: () => act(async () => resolve(AsyncResult.failure(Cause.fail(new Error("offline"))))),
  };
}

async function poll() {
  await act(async () => vi.advanceTimersByTimeAsync(LIVE_REFRESH_INTERVAL_MS));
}

beforeEach(() => {
  renderer = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  invalidate.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  notify.mockReset();
  refreshMetadata.mockReset();
  refreshActivity.mockReset();
  refreshDetail.mockReset();
  props = {
    environmentId: EnvironmentId.make("environment"),
    reference: {
      projectId: ProjectId.make("project"),
      host: "github.com",
      repository: "acme/web",
      number: 7,
    },
    scopeKey: `environment:project:github.com:acme/web#7:test-${++testNumber}`,
    detail: { updatedAt: "2026-09-10T10:00:00Z" },
    refreshMetadata,
    refreshActivity,
    refreshDetail,
    forcedRefreshToken: 0,
  };
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mounted pull request refresh sequencing", () => {
  it("awaits detail-only poll invalidation and preserves activity and diff for unchanged metadata", async () => {
    await render();
    expect(invalidate).not.toHaveBeenCalled();
    const pending = invalidation();
    await poll();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      environmentId: props.environmentId,
      input: { reference: props.reference, scope: "detail" },
    });
    expect(refreshMetadata).not.toHaveBeenCalled();
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
    await pending.succeed();
    expect(refreshMetadata).toHaveBeenCalledOnce();
    await render({ detail: { ...props.detail! } });
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
  });

  it("awaits full invalidation of a polled revision before refreshing activity and the diff", async () => {
    await render();
    await poll();
    expect(refreshMetadata).toHaveBeenCalledOnce();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    expect(invalidate).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: { reference: props.reference },
    });
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
    await pending.succeed();
    expect(refreshActivity).toHaveBeenCalledOnce();
    expect(diffRefreshes()).toBe("1");
  });

  it("ignores a completed invalidation superseded by a newer revision", async () => {
    await render();
    const earlier = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    const latest = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:02:00Z" } });
    await earlier.succeed();
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
    await latest.succeed();
    expect(refreshActivity).toHaveBeenCalledOnce();
    expect(diffRefreshes()).toBe("1");
  });

  it("ignores a revision invalidation after selecting another pull request", async () => {
    await render();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await render({
      reference: { ...props.reference, number: 8 },
      scopeKey: `${props.scopeKey}:other`,
    });
    await pending.succeed();
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
  });

  it("does not refresh activity after the panel unmounts during invalidation", async () => {
    await render();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await act(async () => renderer!.unmount());
    renderer = null;
    await pending.succeed();
    expect(refreshActivity).not.toHaveBeenCalled();
  });

  it("keeps activity and diff on failed revision invalidation and retries on the next metadata result", async () => {
    await render();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await pending.fail();
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await render({ detail: { ...props.detail! } });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(refreshActivity).toHaveBeenCalledOnce();
    expect(diffRefreshes()).toBe("1");
  });

  it("does not reread held metadata when poll invalidation fails", async () => {
    await render();
    const pending = invalidation();
    await poll();
    await pending.fail();
    expect(refreshMetadata).not.toHaveBeenCalled();
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
  });

  it("reports failed manual invalidation without refreshing and allows a successful retry", async () => {
    await render();
    const failed = invalidation();
    await act(async () => {
      void renderer!.root.findByType("button").props.onClick();
    });
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    expect(refreshDetail).not.toHaveBeenCalled();
    await failed.fail();
    expect(refreshDetail).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "The pull request could not be refreshed",
      description: "offline",
    });
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);

    const retry = invalidation();
    await act(async () => {
      void renderer!.root.findByType("button").props.onClick();
    });
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    expect(refreshDetail).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
    await retry.succeed();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(refreshDetail).toHaveBeenCalledOnce();
    expect(diffRefreshes()).toBe("1");
    expect(notify).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });

  it.each(["success", "failure"])(
    "ignores an older manual %s while a forced refresh is pending",
    async (outcome) => {
      await render();
      const older = invalidation();
      await act(async () => {
        void renderer!.root.findByType("button").props.onClick();
      });
      const newer = invalidation();
      await render({ forcedRefreshToken: 1 });
      await (outcome === "success" ? older.succeed() : older.fail());
      expect(renderer!.root.findByType("button").props.disabled).toBe(true);
      expect(refreshDetail).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(diffRefreshes()).toBe("0");
      await newer.succeed();
      expect(renderer!.root.findByType("button").props.disabled).toBe(false);
      expect(refreshDetail).toHaveBeenCalledOnce();
      expect(diffRefreshes()).toBe("1");
    },
  );

  it.each(["scope", "unmount"])("ignores a manual refresh after %s changes", async (change) => {
    await render();
    const pending = invalidation();
    await act(async () => {
      void renderer!.root.findByType("button").props.onClick();
    });
    if (change === "scope") {
      await render({
        scopeKey: `${props.scopeKey}:other`,
        reference: { ...props.reference, number: 8 },
      });
      expect(renderer!.root.findByType("button").props.disabled).toBe(false);
    } else {
      await act(async () => renderer!.unmount());
      renderer = null;
    }
    await pending.succeed();
    expect(refreshDetail).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    if (renderer) expect(diffRefreshes()).toBe("0");
  });

  it("awaits full invalidation before a page refresh", async () => {
    await render();
    const pending = invalidation();
    await render({ forcedRefreshToken: 1 });
    expect(refreshDetail).not.toHaveBeenCalled();
    expect(diffRefreshes()).toBe("0");
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    await pending.succeed();
    expect(refreshDetail).toHaveBeenCalledOnce();
    expect(diffRefreshes()).toBe("1");
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });
});
