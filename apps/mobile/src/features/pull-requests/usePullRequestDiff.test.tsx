import { RegistryContext } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ diff: vi.fn() }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: { diff: mocks.diff } }));

import { usePullRequestDiff } from "./usePullRequestDiff";

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
