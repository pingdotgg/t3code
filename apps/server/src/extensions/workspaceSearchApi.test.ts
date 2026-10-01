import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import type { HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createWorkspaceSearchApiProvider } from "./workspaceSearchApi.ts";

function fixture() {
  const projectId = ProjectId.make("project-a");
  let cwd = "/workspace";
  const calls: Array<{ method: string; input: unknown }> = [];
  const provider = createWorkspaceSearchApiProvider({
    environmentId: "env-a",
    projects: {
      getById: () =>
        Effect.sync(() => Option.some({ projectId, workspaceRoot: cwd, deletedAt: null })),
    },
    threads: { getById: () => Effect.succeedNone },
    entries: {
      search: (input) =>
        Effect.sync(() => {
          calls.push({ method: "search", input });
          return {
            entries: [
              { path: "src/app.ts", kind: "file" as const },
              { path: "src", kind: "directory" as const },
            ],
            truncated: true,
          };
        }),
      searchContents: (input) =>
        Effect.sync(() => {
          calls.push({ method: "searchContents", input });
          return {
            matches: [
              {
                path: "src/app.ts",
                lineNumber: 3,
                lineContent: "const app = 1;",
                matchRanges: [{ start: 6, end: 9 }],
              },
            ],
            truncated: false,
          };
        }),
    },
  });
  const context: ViewContext = {
    client: "web",
    workspaceRevision: JSON.stringify(["/workspace", null]),
    resource: { namespace: "test.search", id: "search", environmentId: "env-a", projectId },
  };
  const holder = { provider };
  const metadata: HostApiInvocationMetadata = {
    callId: "call",
    callerId: "test.search",
    rootCallerId: "test.search",
    providerId: provider.providerId,
    providerGeneration: 1,
    callerGenerations: [],
  };
  return {
    get provider() {
      return holder.provider;
    },
    set provider(next) {
      holder.provider = next;
    },
    context,
    calls,
    invoke: (method: string, input: unknown) =>
      holder.provider.invoke(
        method,
        input as never,
        context,
        new AbortController().signal,
        metadata,
      ),
    move: () => {
      cwd = "/other";
    },
  };
}

it("runs an entry search against the scoped project root with the declared defaults", async () => {
  const f = fixture();
  const result = await f.invoke("search", { query: "app" });
  expect(f.calls).toEqual([
    {
      method: "search",
      input: { cwd: "/workspace", query: "app", limit: 100 },
    },
  ]);
  expect(result).toEqual({
    entries: [
      { path: "src/app.ts", kind: "file" },
      { path: "src", kind: "directory" },
    ],
    truncated: true,
  });
});

it("passes the kind filter and imageOnly through to the index", async () => {
  const f = fixture();
  await f.invoke("search", { query: "app", limit: 25, kind: "file", imageOnly: false });
  expect(f.calls[0]?.input).toEqual({
    cwd: "/workspace",
    query: "app",
    limit: 25,
    kind: "file",
    imageOnly: false,
  });
});

it("rejects over-limit, oversized-query, excess-property and wrong-kind inputs before searching", async () => {
  const f = fixture();
  await expect(f.invoke("search", { query: "x", limit: 201 })).rejects.toThrow("Invalid");
  await expect(f.invoke("search", { query: "x", limit: 0 })).rejects.toThrow("Invalid");
  await expect(f.invoke("search", { query: "q".repeat(257) })).rejects.toThrow("Invalid");
  await expect(f.invoke("search", { query: "x", cwd: "/etc" })).rejects.toThrow("Invalid");
  await expect(f.invoke("search", { query: "x", kind: "symlink" })).rejects.toThrow("Invalid");
  expect(f.calls).toEqual([]);
});

it("runs a content search with the declared defaults and rejects out-of-bounds input", async () => {
  const f = fixture();
  const result = await f.invoke("searchContents", { query: "app" });
  expect(f.calls).toEqual([
    {
      method: "searchContents",
      input: {
        cwd: "/workspace",
        query: "app",
        limit: 100,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      },
    },
  ]);
  expect(result).toEqual({
    matches: [
      {
        path: "src/app.ts",
        lineNumber: 3,
        lineContent: "const app = 1;",
        matchRanges: [{ start: 6, end: 9 }],
      },
    ],
    truncated: false,
  });
  await expect(f.invoke("searchContents", { query: "" })).rejects.toThrow("Invalid");
  await expect(f.invoke("searchContents", { query: "x", limit: 501 })).rejects.toThrow("Invalid");
});

it("clamps line content to the contract bound and reports truncation honestly", async () => {
  const f = fixture();
  const longLine = "a".repeat(9000) + "needle";
  f.provider = createWorkspaceSearchApiProvider({
    environmentId: "env-a",
    projects: {
      getById: () =>
        Effect.sync(() =>
          Option.some({
            projectId: ProjectId.make("project-a"),
            workspaceRoot: "/workspace",
            deletedAt: null,
          }),
        ),
    },
    threads: { getById: () => Effect.succeedNone },
    entries: {
      search: () => Effect.succeed({ entries: [], truncated: false }),
      searchContents: () =>
        Effect.succeed({
          matches: [
            {
              path: "long.txt",
              lineNumber: 1,
              lineContent: longLine,
              matchRanges: [
                { start: 9000, end: 9006 },
                { start: 10, end: 9000 },
              ],
            },
            { path: "p".repeat(600), lineNumber: 1, lineContent: "x", matchRanges: [] },
          ],
          truncated: false,
        }),
    },
  });
  const result = (await f.invoke("searchContents", { query: "needle" })) as {
    matches: Array<{ lineContent: string; matchRanges: Array<{ start: number; end: number }> }>;
    truncated: boolean;
  };
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]?.lineContent).toHaveLength(8192);
  // The range starting past the cut is dropped; the crossing range is clamped.
  expect(result.matches[0]?.matchRanges).toEqual([{ start: 10, end: 8192 }]);
  // The over-path-limit match was dropped, so truncation is honestly reported.
  expect(result.truncated).toBe(true);
});

it("rejects unknown methods and re-resolves authority after the search", async () => {
  const f = fixture();
  await expect(f.invoke("delete", {})).rejects.toThrow("unavailable");
  f.move();
  await expect(f.invoke("search", { query: "app" })).rejects.toThrow();
});
