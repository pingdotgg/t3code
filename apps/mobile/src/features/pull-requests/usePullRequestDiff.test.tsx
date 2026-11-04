import { RegistryContext } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ diff: vi.fn() }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: { diff: mocks.diff } }));

import { usePullRequestDiff, usePullRequestDiffEntry } from "./usePullRequestDiff";
import * as reviewModel from "../review/reviewModel";
import { getCachedNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";

function patch(path: string, nextCursor: string | null = null): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    truncated: false,
    nextCursor,
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const requests: {
    cursor: string | null;
    resolve: (value: PullRequestDiffResult) => void;
    reject: (error: Error) => void;
  }[] = [];
  const queries = Atom.family((cursor: string | null) =>
    Atom.make(
      Effect.tryPromise(
        () =>
          new Promise<PullRequestDiffResult>((resolve, reject) => {
            requests.push({ cursor, resolve, reject });
          }),
      ),
    ).pipe(Atom.keepAlive),
  );
  mocks.diff.mockImplementation((target: { input: { cursor?: string } }) =>
    queries(target.input.cursor ?? null),
  );
  const root = createRoot(document.createElement("div"));
  let current: ReturnType<typeof usePullRequestDiff>;
  function Probe() {
    const result = usePullRequestDiff(
      {
        environmentId: "environment",
        projectId: "project",
        repository: "repo",
        number: 1,
      },
      sourceControlClients.get("github").changeRequest,
    );
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
  return {
    requests,
    remount() {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <Probe key="new-route" />
          </RegistryContext.Provider>,
        ),
      );
    },
    get current() {
      return current;
    },
    async succeed(index: number, result: PullRequestDiffResult) {
      await act(async () => {
        requests[index]!.resolve(result);
      });
    },
    async fail(index: number) {
      await act(async () => {
        requests[index]!.reject(new Error("Connection lost"));
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("reuses the parsed snapshot when a new route reads the same query result", async () => {
  using parse = vi.spyOn(reviewModel, "buildReviewParsedDiff");
  using screen = setup();
  await screen.succeed(0, patch("first.ts"));
  const parsed = screen.current.parsed;
  const parses = parse.mock.calls.length;
  screen.remount();
  expect(screen.current.parsed).toBe(parsed);
  expect(parse).toHaveBeenCalledTimes(parses);
  expect(screen.requests).toHaveLength(1);
});

function setupEntry() {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const requestFrame = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
  const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    if (id != null) frames.delete(id);
  });
  const listeners = new Map<string, (event: { data: { closing: boolean } }) => void>();
  const navigation = {
    addListener(
      type: "transitionStart" | "transitionEnd",
      listener: (event: { data: { closing: boolean } }) => void,
    ) {
      listeners.set(type, listener);
      return () => {
        listeners.delete(type);
      };
    },
  };
  const events: string[] = [];
  const prepare = vi.fn(() => {
    events.push("prepare");
    return getCachedNativeReviewDiffData({
      parsedDiff: reviewModel.buildReviewParsedDiff(
        patch("first.ts").patch + patch("neighbor.ts").patch,
        "entry",
      ),
    });
  });
  function Body() {
    const [data] = useState(prepare);
    return <div>{data.files.map((file) => file.path).join(",")}</div>;
  }
  function Entry() {
    const ready = usePullRequestDiffEntry(navigation);
    useLayoutEffect(() => {
      events.push(ready ? "body-commit" : "shell-commit");
    }, [ready]);
    return ready ? <Body /> : <div>Opening changes</div>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Entry />));
  return {
    prepare,
    events,
    container,
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      act(() => {
        for (const callback of pending) callback(0);
      });
    },
    event(type: "transitionStart" | "transitionEnd", closing = false) {
      act(() => listeners.get(type)?.({ data: { closing } }));
    },
    fallback() {
      act(() => vi.runAllTimers());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    },
  };
}

it("commits the loading shell and waits for the opening transition before building the diff", () => {
  using screen = setupEntry();
  expect(screen.events).toEqual(["shell-commit"]);
  screen.event("transitionStart");
  screen.frame();
  screen.frame();
  screen.event("transitionEnd", true);
  expect(screen.prepare).not.toHaveBeenCalled();
  screen.event("transitionEnd");
  expect(screen.events).toEqual(["shell-commit", "prepare", "body-commit"]);
  expect(screen.container.textContent).toBe("first.ts,neighbor.ts");
});

it.each(["unanimated", "missing-completion"] as const)(
  "opens the diff after a %s presentation without stranding the shell",
  (presentation) => {
    using screen = setupEntry();
    if (presentation === "missing-completion") screen.event("transitionStart");
    screen.frame();
    expect(screen.prepare).not.toHaveBeenCalled();
    screen.frame();
    if (presentation === "missing-completion") {
      expect(screen.prepare).not.toHaveBeenCalled();
      screen.fallback();
    }
    expect(screen.prepare).toHaveBeenCalledOnce();
  },
);

it("retries a failed continuation without discarding loaded files or restarting page one", async () => {
  using screen = setup();
  await screen.succeed(0, patch("first.ts", "second"));
  act(() => screen.current.loadMore());
  await screen.fail(1);
  expect(screen.current.error).not.toBeNull();
  expect(screen.current.patch).toContain("first.ts");

  act(() => screen.current.refresh());
  expect(screen.requests.map((request) => request.cursor)).toEqual([null, "second", "second"]);
  expect(screen.current.patch).toContain("first.ts");
  await screen.succeed(2, patch("second.ts"));
  expect(screen.current.error).toBeNull();
  expect(screen.current.parsed.kind).toBe("files");
  if (screen.current.parsed.kind !== "files") throw new Error("Expected files");
  expect(screen.current.parsed.files.map((file) => file.path)).toEqual(["first.ts", "second.ts"]);
  expect(screen.current.nextCursor).toBeNull();
});

it("still refreshes from page one after successfully loading a continuation", async () => {
  using screen = setup();
  await screen.succeed(0, patch("first.ts", "second"));
  act(() => screen.current.loadMore());
  await screen.succeed(1, patch("second.ts"));
  act(() => screen.current.refresh());
  await screen.succeed(2, patch("refreshed.ts"));
  if (screen.current.parsed.kind !== "files") throw new Error("Expected files");
  expect(screen.current.parsed.files.map((file) => file.path)).toEqual(["refreshed.ts"]);
});
