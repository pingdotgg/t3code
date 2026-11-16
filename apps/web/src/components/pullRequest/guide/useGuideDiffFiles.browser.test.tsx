import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type PullRequestDiffResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  heads: new Map<
    string,
    Map<string | null, Atom.Atom<AsyncResult.AsyncResult<PullRequestDiffResult>>>
  >(),
  pages: new Map<string | null, Atom.Atom<AsyncResult.AsyncResult<PullRequestDiffResult>>>(),
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    diff: ({ input }: { input: { cursor?: string; cacheHeadSha?: string } }) =>
      (state.heads.get(input.cacheHeadSha ?? "") ?? state.pages).get(input.cursor ?? null)!,
  },
}));

import { useGuideDiffFiles } from "./useGuideDiffFiles";

function Probe({ wantedPaths, headSha = "new-head" }: { wantedPaths: string[]; headSha?: string }) {
  const diff = useGuideDiffFiles({
    environmentId: EnvironmentId.make("test"),
    reference: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
    headSha,
    wantedPaths,
  });
  return (
    <output>
      {JSON.stringify({
        loading: diff.loading,
        files: [...diff.files].map(([path, file]) => [path, file.additionLines.join("")]),
      })}
    </output>
  );
}

function setup() {
  state.pages.clear();
  state.heads.clear();
}

function page(path: string, value: string, nextCursor: string | null): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${value}\n`,
    truncated: false,
    nextCursor,
  };
}

it.each([
  { name: "contains the requested file", path: "wanted.ts", cursor: null },
  { name: "ends before a newly added file", path: "other.ts", cursor: null },
  { name: "has an obsolete next cursor", path: "other.ts", cursor: "old-next" },
])("waits for a cached page that $name to settle", async ({ path, cursor }) => {
  setup();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const first = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(page(path, "STALE", cursor), { waiting: true }),
  );
  state.pages.set(null, first);
  state.pages.set(
    "old-next",
    Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(AsyncResult.initial(true)),
  );
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} />
    </RegistryContext.Provider>,
  );
  const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result()).toEqual({ loading: true, files: [] });

  await act(() => registry.set(first, AsyncResult.success(page("wanted.ts", "FRESH", null))));
  expect(result()).toEqual({ loading: false, files: [["wanted.ts", "FRESH\n"]] });
});

it("walks more cached pages than React's re-render limit and stops at the requested file", async () => {
  setup();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const pageCount = 30;
  for (let index = 0; index < pageCount; index++) {
    const last = index === pageCount - 1;
    state.pages.set(
      index === 0 ? null : `cursor-${index}`,
      Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
        AsyncResult.success(
          page(last ? "wanted.ts" : `file-${index}.ts`, "FOUND", `cursor-${index + 1}`),
        ),
      ),
    );
  }
  let pastPageReads = 0;
  state.pages.set(
    `cursor-${pageCount}`,
    Atom.make((): AsyncResult.AsyncResult<PullRequestDiffResult> => {
      pastPageReads++;
      return AsyncResult.initial(true);
    }),
  );
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} />
    </RegistryContext.Provider>,
  );
  const result = JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result.loading).toBe(false);
  expect(result.files).toContainEqual(["wanted.ts", "FOUND\n"]);
  expect(pastPageReads).toBe(0);
});

it("waits for a later cached page that is still refreshing", async () => {
  setup();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  state.pages.set(
    null,
    Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
      AsyncResult.success(page("first.ts", "FIRST", "cursor-1")),
    ),
  );
  const second = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(page("other.ts", "STALE", "old-next"), { waiting: true }),
  );
  state.pages.set("cursor-1", second);
  state.pages.set(
    "old-next",
    Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(AsyncResult.initial(true)),
  );
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} />
    </RegistryContext.Provider>,
  );
  const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result()).toEqual({ loading: true, files: [["first.ts", "FIRST\n"]] });

  await act(() => registry.set(second, AsyncResult.success(page("wanted.ts", "FRESH", null))));
  expect(result()).toEqual({
    loading: false,
    files: [
      ["first.ts", "FIRST\n"],
      ["wanted.ts", "FRESH\n"],
    ],
  });
});

it("replaces cached excerpts when a new guide head receives a refreshed diff", async () => {
  setup();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const first = Atom.make<AsyncResult.AsyncResult<PullRequestDiffResult>>(
    AsyncResult.success(page("wanted.ts", "OLD_HEAD", null)),
  );
  state.pages.set(null, first);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} headSha="old-head" />
    </RegistryContext.Provider>,
  );
  const result = () => JSON.parse(screen.container.querySelector("output")!.textContent!);
  expect(result().files).toEqual([["wanted.ts", "OLD_HEAD\n"]]);

  await screen.rerender(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} headSha="new-head" />
    </RegistryContext.Provider>,
  );
  await act(() => registry.set(first, AsyncResult.success(page("wanted.ts", "NEW_HEAD", null))));
  expect(result().files).toEqual([["wanted.ts", "NEW_HEAD\n"]]);
});

it("fetches later pages again after a head change even when the first page is unchanged", async () => {
  setup();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const first = page("first.ts", "UNCHANGED", "cursor-1");
  const fetchPage = vi.fn(async (head: string, cursor: string | null) =>
    cursor === null ? first : page("wanted.ts", head, null),
  );
  for (const head of ["old-head", "new-head"]) {
    state.heads.set(
      head,
      new Map(
        [null, "cursor-1"].map((cursor) => [
          cursor,
          Atom.make(Effect.promise(() => fetchPage(head, cursor))),
        ]),
      ),
    );
  }
  // The previous push's pages are already cached under the unversioned identity.
  state.pages.set(null, Atom.make(AsyncResult.success(first)));
  state.pages.set("cursor-1", Atom.make(AsyncResult.success(page("wanted.ts", "old-head", null))));
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} headSha="old-head" />
    </RegistryContext.Provider>,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("old-head"));
  await screen.rerender(
    <RegistryContext.Provider value={registry}>
      <Probe wantedPaths={["wanted.ts"]} headSha="new-head" />
    </RegistryContext.Provider>,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("new-head"));
  expect(fetchPage).toHaveBeenCalledWith("new-head", null);
  expect(fetchPage).toHaveBeenCalledWith("new-head", "cursor-1");
});
