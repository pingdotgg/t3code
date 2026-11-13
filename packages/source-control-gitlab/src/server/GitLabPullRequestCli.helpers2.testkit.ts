// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

export const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();

export const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: mockedExecute,
      }),
    ),
  ),
);

export function output(stdout: string, stdoutTruncated = false, stdoutInvalidUtf8 = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
    stdoutInvalidUtf8,
  };
}

export function mergeRequests(count: number, firstNumber: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstNumber + index,
      title: `Merge request ${firstNumber + index}`,
      web_url: `https://gitlab.com/acme/web/-/merge_requests/${firstNumber + index}`,
      source_branch: "feat/page",
      target_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    })),
  );
}

export function diffPage(firstIndex: number, count = 100): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      old_path: `src/${firstIndex + index}.ts`,
      new_path: `src/${firstIndex + index}.ts`,
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    })),
  );
}

export function notes(count: number, firstId: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      body: `note ${firstId + index}`,
      author: { username: "bilal" },
      created_at: "2026-07-01T00:00:00Z",
    })),
  );
}

export const author = { id: 1, username: "bilal" };

export const reviewer = { id: 5, username: "octocat" };

export function mergeRequestJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 7,
    title: "Merge request 7",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    author,
    ...overrides,
  });
}

export function argsOfCall(index: number): ReadonlyArray<string> {
  return callAt(index).args;
}

export function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}
