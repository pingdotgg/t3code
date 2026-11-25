import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WorkflowHandlers from "./handlers.ts";
import { WorkflowToolkit } from "./tools.ts";

const fullAccess = { sessionId: "session-1", label: "t3 CLI", access: "full-access" } as const;
const supervised = { sessionId: "session-2", label: "Bot", access: "approval-required" } as const;

const handlersWith = (
  workflows: Partial<Workflows.Workflows["Service"]>,
  scope: Partial<McpInvocationContext.McpInvocationScope> = {},
) =>
  McpToolAccess.HandlersLayer.layer(WorkflowHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:workflow"),
          requestNamespace: "client:workflow",
          thread: undefined,
          client: fullAccess,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          ...scope,
        }),
        Layer.mock(Workflows.Workflows)(workflows),
      ),
    ),
  );

it.effect("start passes an explicit null payload through and defaults an omitted one to {}", () =>
  Effect.gen(function* () {
    const payloads: Array<unknown> = [];
    yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      for (const input of [{ input: null }, {}]) {
        yield* toolkit
          .handle("t3_workflow", {
            action: "start",
            workflow: "echo",
            idempotencyKey: "trial",
            ...input,
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }
    }).pipe(
      Effect.provide(
        handlersWith({
          start: (_workflow, input) =>
            Effect.sync(() => {
              payloads.push(input);
              return { runId: "run-1" };
            }),
          get: () => Effect.succeed({ run: undefined, steps: [], references: [] } as never),
        }),
      ),
    );
    expect(payloads).toEqual([null, {}]);
  }),
);

it.effect("signal refuses a run destination mixed with a channel destination", () =>
  Effect.gen(function* () {
    const delivered: Array<unknown> = [];
    const results = yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      return yield* Effect.forEach(
        [
          { runId: "run-1", wait: "review", channel: "other" },
          { workflow: "other", channel: "other", runId: "run-1" },
          { runId: "run-1", wait: "review" },
        ],
        (address) =>
          toolkit
            .handle("t3_workflow", { action: "signal", value: { choice: "yes" }, ...address })
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.map((parts) => parts.at(-1)?.result),
            ),
      );
    }).pipe(
      Effect.provide(
        handlersWith({
          signal: (address) =>
            Effect.sync(() => {
              delivered.push(address);
              return "delivered" as const;
            }),
        }),
      ),
    );
    for (const result of results.slice(0, -1)) {
      expect(result).toMatchObject({ code: "invalid_request" });
    }
    expect(results.at(-1)).toEqual({ delivery: "delivered" });
    expect(delivered).toEqual([{ runId: "run-1", wait: "review" }]);
  }),
);

const emptyRun = { run: undefined, steps: [], references: [] } as never;
const call = (input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* WorkflowToolkit;
    return yield* toolkit.handle("t3_workflow", input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
  });

const changes = [
  { action: "start", workflow: "release", idempotencyKey: "trial" },
  { action: "signal", runId: "run-1", wait: "review", value: { choice: "yes" } },
  { action: "resume", runId: "run-1" },
  { action: "cancel", runId: "run-1" },
  { action: "store_set", key: "switch", value: true },
  { action: "store_delete", key: "switch" },
];

it.effect("a caller below the broadest mode reads runs but does not start or change them", () =>
  Effect.gen(function* () {
    const reached: Array<string> = [];
    const reach = (name: string) => () => Effect.sync(() => void reached.push(name));
    const results = yield* Effect.forEach(
      [...changes, { action: "list" }, { action: "questions" }],
      call,
    ).pipe(
      Effect.provide(
        handlersWith(
          {
            start: () => Effect.sync(() => (reached.push("start"), { runId: "run-1" })),
            signal: () => Effect.sync(() => (reached.push("signal"), "delivered" as const)),
            resume: reach("resume"),
            cancel: reach("cancel"),
            storeSet: reach("storeSet"),
            storeDelete: reach("storeDelete"),
            stored: () => Effect.succeed([]),
            get: () => Effect.succeed(emptyRun),
            list: () => Effect.succeed([]),
            questions: Effect.succeed([]),
          },
          { client: supervised },
        ),
      ),
    );
    for (const result of results.slice(0, changes.length)) {
      expect(result).toMatchObject({ code: "capability_denied" });
    }
    expect(reached).toEqual([]);
    expect(results.slice(changes.length)).toEqual([{ runs: [] }, { questions: [] }]);
  }),
);

it.effect("hook paths go only to a caller at the broadest mode", () =>
  Effect.gen(function* () {
    const hooks = [{ workflow: "release", name: "push", path: "/api/hooks/wf-release.push/token" }];
    const read = (client: McpInvocationContext.McpClientCaller) =>
      call({ action: "hooks" }).pipe(
        Effect.provide(handlersWith({ hooks: Effect.succeed(hooks as never) }, { client })),
      );
    expect(yield* read(fullAccess)).toEqual({ hooks });
    const refused = yield* read(supervised);
    expect(refused).toMatchObject({ code: "capability_denied" });
    expect(JSON.stringify(refused)).not.toContain("token");
  }),
);

it.effect("under an administrator's ceiling, a caller at the ceiling starts runs", () =>
  Effect.gen(function* () {
    const start = { action: "start", workflow: "release", idempotencyKey: "trial" };
    const started: Array<string> = [];
    const workflows = {
      start: (name: string) => Effect.sync(() => (started.push(name), { runId: "run-1" })),
      get: () => Effect.succeed(emptyRun),
    };
    const narrowedTo = (runtimeMode: "auto" | "approval-required") => ({
      runtimeModeCeiling: "auto" as const,
      client: { ...fullAccess, narrowedTo: { runtimeMode, interactionMode: "default" as const } },
    });
    expect(
      yield* call(start).pipe(Effect.provide(handlersWith(workflows, narrowedTo("auto")))),
    ).toEqual({ steps: [], references: [] });
    expect(started).toEqual(["release"]);
    expect(
      yield* call(start).pipe(
        Effect.provide(handlersWith(workflows, narrowedTo("approval-required"))),
      ),
    ).toMatchObject({ code: "capability_denied" });
    expect(started).toEqual(["release"]);
  }),
);

it.effect("questions are narrowed to a kind, and runs to a tag", () =>
  Effect.gen(function* () {
    const filters: Array<unknown> = [];
    const question = (name: string, kind?: string) => ({
      runId: "run-1",
      name,
      request: { title: name, choices: ["Yes"] },
      ...(kind === undefined ? {} : { kind }),
      askedAt: "2026-11-20T00:00:00.000Z",
      thread: null,
    });
    const results = yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      return yield* Effect.forEach(
        [
          { action: "questions" as const, kind: "feature" },
          { action: "questions" as const },
          { action: "list" as const, tag: "backlog" },
        ],
        (input) =>
          toolkit.handle("t3_workflow", input).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          ),
      );
    }).pipe(
      Effect.provide(
        handlersWith({
          questions: Effect.succeed([
            question("wanted", "feature"),
            question("meant", "intended"),
            question("plain"),
          ]),
          list: (filter) =>
            Effect.sync(() => {
              filters.push(filter);
              return [];
            }),
        }),
      ),
    );
    expect(results[0]).toMatchObject({ questions: [{ name: "wanted" }] });
    expect(results[1]).toMatchObject({
      questions: [{ name: "wanted" }, { name: "meant" }, { name: "plain" }],
    });
    expect(filters).toEqual([{ tag: "backlog" }]);
  }),
);
