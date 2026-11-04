import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  listThreads,
  readLatestMessages,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});

const repo = { canonicalKey: "github.com/acme/app" };
const projectList = (...projects: Array<{ id: string; repositoryIdentity?: typeof repo }>) => ({
  projects: projects.map((project) => ({
    title: project.id,
    workspaceRoot: `/work/${project.id}`,
    ...project,
  })),
  nextCursor: null,
});
const threadPage = (nextCursor: number | null) => ({
  projectId: null,
  currentThreadId: null,
  threads: [],
  nextCursor,
  total: 0,
});
const listAt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.WorkingDirectory, "/work/app"),
    Effect.provide(NodeServices.layer),
  );

it.effect(
  "list elsewhere takes that environment's project id or the one with this repository",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("env-remote");
      for (const project of ["remote-app", "."]) {
        const { tools, calls } = scriptedTools({
          t3_project_list: [
            projectList({ id: "remote-app", repositoryIdentity: repo }, { id: "remote-other" }),
            projectList({ id: "app", repositoryIdentity: repo }),
          ],
          t3_thread_list: [threadPage(1), threadPage(null)],
        });

        yield* listThreads(tools, {
          environment: Option.some(environmentId),
          allEnvironments: false,
          project: Option.some(project),
          allProjects: false,
        });

        assert.deepStrictEqual(
          calls.filter((entry) => entry.tool === "t3_thread_list").map((entry) => entry.args),
          [0, 1].map((cursor) => ({
            environmentId,
            projectId: "remote-app",
            includeSubagents: false,
            limit: 100,
            cursor,
          })),
        );
      }
    }).pipe(listAt),
);

it.effect("--all-environments skips a linked environment it cannot list", () =>
  Effect.gen(function* () {
    const link = (id: string, status: "reachable" | "unreachable") => ({
      environmentId: id,
      label: id,
      status,
      access: "read-only",
      expiresAt: "2026-12-01T00:00:00.000Z",
      lastError: null,
    });
    const { tools, calls } = scriptedTools({
      t3_environment_read: [{ environmentId: "env-here", label: "here" }],
      t3_environment_links: [
        {
          environmentId: "env-here",
          links: [
            link("env-a", "reachable"),
            link("env-b", "unreachable"),
            link("env-c", "reachable"),
          ],
          notListed: "",
        },
      ],
      t3_project_list: [
        projectList({ id: "app", repositoryIdentity: repo }),
        projectList({ id: "a-app", repositoryIdentity: repo }),
        projectList({ id: "app", repositoryIdentity: repo }),
        projectList({ id: "c-other" }),
        projectList({ id: "app", repositoryIdentity: repo }),
      ],
      t3_thread_list: [threadPage(null), threadPage(null)],
    });

    const listed = yield* listThreads(tools, {
      environment: Option.none(),
      allEnvironments: true,
      project: Option.none(),
      allProjects: false,
    });

    assert.deepStrictEqual(
      listed.map((entry) => entry.label),
      ["here", "env-a"],
    );
    assert.deepStrictEqual(
      calls
        .filter((entry) => entry.tool === "t3_thread_list")
        .map((entry) => (entry.args as { projectId: string }).projectId),
      ["app", "a-app"],
    );
  }).pipe(listAt),
);
