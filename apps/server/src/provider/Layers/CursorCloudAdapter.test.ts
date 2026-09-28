// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeCursorCloudAdapter, routeCursorExecution } from "./CursorCloudAdapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("cursorCloud");
const THREAD_ID = ThreadId.make("thread-cloud");
const SETTINGS = { cloudAutoCreatePR: true };
const ENVIRONMENT = { ...process.env, CURSOR_API_KEY: "key_test" };

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly lastEventId: string | undefined;
  readonly body: unknown;
}

type Route = (request: RecordedRequest) => Response | undefined;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const sse = (events: ReadonlyArray<{ id?: string; event: string; data: unknown }>) =>
  new Response(
    events
      .map(
        (entry) =>
          `${entry.id ? `id: ${entry.id}\n` : ""}event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

function fakeCursorApi(routes: ReadonlyArray<Route>) {
  const requests: RecordedRequest[] = [];
  const decoder = new TextDecoder();
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(decoder.decode(request.body.body))
        : undefined;
    const recorded: RecordedRequest = {
      method: request.method,
      path: new URL(request.url).pathname,
      lastEventId: request.headers["last-event-id"],
      body,
    };
    requests.push(recorded);
    for (const route of routes) {
      const response = route(recorded);
      if (response) return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 })));
  });
  return { client, requests };
}

const route =
  (method: string, path: string, respond: (request: RecordedRequest) => Response): Route =>
  (request) =>
    request.method === method && request.path === path ? respond(request) : undefined;

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-cursor-cloud-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** A checkout on `main` that is already pushed to a GitHub `origin`. */
const makePushedRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-cloud-repo-" });
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  git("init", "--quiet", "-b", "main");
  git(
    "-c",
    "user.name=T3",
    "-c",
    "user.email=t3@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "init",
  );
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("config", "branch.main.remote", "origin");
  git("config", "branch.main.merge", "refs/heads/main");
  return cwd;
});

const collectUntilTurnCompleted = (streamEvents: Stream.Stream<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(streamEvents, (event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(
          event.type === "turn.completed" ? Deferred.succeed(done, undefined) : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);
    return {
      events,
      completed: Deferred.await(done).pipe(
        Effect.andThen(Fiber.interrupt(fiber)),
        Effect.as(events),
      ),
    };
  });

it.layer(testLayer)("CursorCloudAdapter", (it) => {
  it.effect("creates an agent from the chosen branch and streams its run into the thread", () =>
    Effect.gen(function* () {
      const cwd = yield* makePushedRepository;
      const api = fakeCursorApi([
        route("POST", "/v1/agents", () =>
          json({
            agent: { id: "bc-1", url: "https://cursor.com/agents/bc-1", status: "ACTIVE" },
            run: { id: "run-1", agentId: "bc-1", status: "CREATING" },
          }),
        ),
        route("GET", "/v1/agents/bc-1/runs/run-1/stream", () =>
          sse([
            { event: "status", data: { runId: "run-1", status: "RUNNING" } },
            { id: "1", event: "assistant", data: { text: "Listing files." } },
            {
              id: "2",
              event: "tool_call",
              data: {
                callId: "c1",
                name: "run_terminal_cmd",
                status: "running",
                args: { command: "ls" },
              },
            },
            {
              id: "3",
              event: "tool_call",
              data: {
                callId: "c1",
                name: "run_terminal_cmd",
                status: "completed",
                args: { command: "ls" },
              },
            },
            {
              id: "4",
              event: "result",
              data: {
                runId: "run-1",
                status: "FINISHED",
                text: "Listing files.",
                git: {
                  branches: [
                    {
                      repoUrl: "github.com/acme/widgets",
                      branch: "cursor/list-files",
                      prUrl: "https://github.com/acme/widgets/pull/7",
                    },
                  ],
                },
              },
            },
            { id: "5", event: "done", data: {} },
          ]),
        ),
      ]);
      const adapter = yield* makeCursorCloudAdapter(SETTINGS, {
        environment: ENVIRONMENT,
        instanceId: INSTANCE_ID,
      }).pipe(Effect.provideService(HttpClient.HttpClient, api.client));
      const collector = yield* collectUntilTurnCompleted(adapter.streamEvents);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        providerInstanceId: INSTANCE_ID,
        cwd,
        branch: "main",
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: INSTANCE_ID,
          model: "composer-2",
          options: [{ id: "fast", value: true }],
        },
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "List the files",
        interactionMode: "plan",
      });
      const events = yield* collector.completed;

      expect(api.requests.find((request) => request.path === "/v1/agents")?.body).toEqual({
        prompt: { text: "List the files" },
        model: { id: "composer-2", params: [{ id: "fast", value: "true" }] },
        repos: [{ url: "https://github.com/acme/widgets", startingRef: "main" }],
        autoCreatePR: true,
        mode: "plan",
      });
      expect(
        events
          .filter(
            (event) => event.type !== "session.started" && event.type !== "session.state.changed",
          )
          .map((event) => event.type),
      ).toEqual([
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "item.completed",
        "item.started",
        "item.completed",
        "thread.metadata.updated",
        "turn.completed",
      ]);
      const tool = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      expect(tool?.type === "item.completed" ? tool.payload.detail : undefined).toBe("ls");
      const turnCompleted = events.at(-1);
      expect(
        turnCompleted?.type === "turn.completed" ? turnCompleted.payload.state : undefined,
      ).toBe("completed");
      const pullRequest = events.find((event) => event.type === "thread.metadata.updated");
      expect(
        pullRequest?.type === "thread.metadata.updated"
          ? pullRequest.payload.pullRequestUrl
          : undefined,
      ).toBe("https://github.com/acme/widgets/pull/7");
      // The settled cursor no longer names a run, so recovery will not reattach to it.
      const [session] = yield* adapter.listSessions();
      expect(session?.resumeCursor).toEqual({
        schemaVersion: 1,
        kind: "cloud",
        agentId: "bc-1",
        agentUrl: "https://cursor.com/agents/bc-1",
        model: "composer-2",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("resumes a dropped run stream from the last event it received", () =>
    Effect.gen(function* () {
      let streamRequests = 0;
      const api = fakeCursorApi([
        route("POST", "/v1/agents/bc-1/runs", () =>
          json({ run: { id: "run-2", agentId: "bc-1", status: "CREATING" } }),
        ),
        route("GET", "/v1/agents/bc-1/runs/run-2", () =>
          json({ id: "run-2", agentId: "bc-1", status: "RUNNING" }),
        ),
        route("GET", "/v1/agents/bc-1/runs/run-2/stream", () => {
          streamRequests += 1;
          return streamRequests === 1
            ? sse([{ id: "7", event: "assistant", data: { text: "Hel" } }])
            : sse([
                { id: "8", event: "assistant", data: { text: "lo" } },
                {
                  id: "9",
                  event: "result",
                  data: { runId: "run-2", status: "FINISHED", text: "Hello" },
                },
              ]);
        }),
      ]);
      const adapter = yield* makeCursorCloudAdapter(SETTINGS, {
        environment: ENVIRONMENT,
        instanceId: INSTANCE_ID,
      }).pipe(Effect.provideService(HttpClient.HttpClient, api.client));
      const collector = yield* collectUntilTurnCompleted(adapter.streamEvents);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        providerInstanceId: INSTANCE_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, kind: "cloud", agentId: "bc-1" },
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Say hello" });
      const events = yield* collector.completed;

      expect(
        api.requests
          .filter((request) => request.path.endsWith("/stream"))
          .map((request) => request.lastEventId),
      ).toEqual([undefined, "7"]);
      expect(
        events.flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : [])),
      ).toEqual(["Hel", "lo"]);
      expect(api.requests.find((request) => request.path === "/v1/agents/bc-1/runs")?.body).toEqual(
        {
          prompt: { text: "Say hello" },
          mode: "agent",
        },
      );
    }).pipe(Effect.scoped),
  );

  for (const recovery of ["finished run", "expired cursor"] as const) {
    it.effect(`preserves the final reply after a partial stream and ${recovery}`, () =>
      Effect.gen(function* () {
        let connections = 0;
        const api = fakeCursorApi([
          route("POST", "/v1/agents/bc-1/runs", () =>
            json({ run: { id: "run-2", agentId: "bc-1", status: "RUNNING" } }),
          ),
          route("GET", "/v1/agents/bc-1/runs/run-2", () =>
            json({
              id: "run-2",
              agentId: "bc-1",
              status: recovery === "finished run" ? "FINISHED" : "RUNNING",
              result: "Hello world.",
            }),
          ),
          route("GET", "/v1/agents/bc-1/runs/run-2/stream", () => {
            connections += 1;
            if (connections === 1)
              return sse([{ id: "7", event: "assistant", data: { text: "Hel" } }]);
            if (connections === 2) return new Response("{}", { status: 410 });
            return sse([
              { id: "7", event: "assistant", data: { text: "Hello world." } },
              { id: "8", event: "result", data: { status: "FINISHED", text: "Hello world." } },
            ]);
          }),
        ]);
        const adapter = yield* makeCursorCloudAdapter(SETTINGS, {
          environment: ENVIRONMENT,
          instanceId: INSTANCE_ID,
        }).pipe(Effect.provideService(HttpClient.HttpClient, api.client));
        const collector = yield* collectUntilTurnCompleted(adapter.streamEvents);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, kind: "cloud", agentId: "bc-1" },
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Say hello" });
        const events = yield* collector.completed;
        const completions = events.filter(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        );
        expect(completions).toHaveLength(2);
        expect(completions[0]).toMatchObject({ itemId: "run-2:assistant:1" });
        expect(completions[1]).toMatchObject({ payload: { detail: "Hello world." } });
        expect(events.at(-1)).toMatchObject({
          type: "turn.completed",
          payload: { state: "completed" },
        });
        expect(
          api.requests
            .filter((request) => request.path.endsWith("/stream"))
            .map((request) => request.lastEventId),
        ).toEqual(recovery === "finished run" ? [undefined] : [undefined, "7", undefined]);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("reattaches to a run left in flight and reports only its result", () =>
    Effect.gen(function* () {
      const api = fakeCursorApi([
        route("GET", "/v1/agents/bc-1/runs/run-9/stream", () =>
          sse([
            { id: "1", event: "assistant", data: { text: "Already shown before the restart." } },
            {
              id: "2",
              event: "result",
              data: { runId: "run-9", status: "FINISHED", text: "Done." },
            },
          ]),
        ),
      ]);
      const adapter = yield* makeCursorCloudAdapter(SETTINGS, {
        environment: ENVIRONMENT,
        instanceId: INSTANCE_ID,
      }).pipe(Effect.provideService(HttpClient.HttpClient, api.client));
      const collector = yield* collectUntilTurnCompleted(adapter.streamEvents);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        providerInstanceId: INSTANCE_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          kind: "cloud",
          agentId: "bc-1",
          activeRun: { runId: "run-9", turnId: "turn-9" },
        },
      });
      expect(session.status).toBe("running");
      const events = yield* collector.completed;

      expect(events.some((event) => event.type === "content.delta")).toBe(false);
      const reply = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      expect(reply?.type === "item.completed" ? reply.payload.detail : undefined).toBe("Done.");
      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        turnId: TurnId.make("turn-9"),
      });
    }).pipe(Effect.scoped),
  );

  it.effect("cancels the active run when the turn is interrupted", () =>
    Effect.gen(function* () {
      let markCancelled!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        markCancelled = resolve;
      });
      const api = fakeCursorApi([
        route("POST", "/v1/agents/bc-1/runs", () =>
          json({ run: { id: "run-3", agentId: "bc-1", status: "CREATING" } }),
        ),
        route("POST", "/v1/agents/bc-1/runs/run-3/cancel", () => {
          markCancelled();
          return json({ id: "run-3" });
        }),
        // The run only ends once Cursor has been asked to cancel it.
        route(
          "GET",
          "/v1/agents/bc-1/runs/run-3/stream",
          () =>
            new Response(
              new ReadableStream({
                start: (controller) => {
                  void cancelled.then(() => {
                    controller.enqueue(
                      new TextEncoder().encode(
                        `id: 1\nevent: result\ndata: ${JSON.stringify({ runId: "run-3", status: "CANCELLED" })}\n\n`,
                      ),
                    );
                    controller.close();
                  });
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        ),
      ]);
      const adapter = yield* makeCursorCloudAdapter(SETTINGS, {
        environment: ENVIRONMENT,
        instanceId: INSTANCE_ID,
      }).pipe(Effect.provideService(HttpClient.HttpClient, api.client));
      const collector = yield* collectUntilTurnCompleted(adapter.streamEvents);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        providerInstanceId: INSTANCE_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, kind: "cloud", agentId: "bc-1" },
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Start something long" });
      yield* adapter.interruptTurn(THREAD_ID);
      const events = yield* collector.completed;

      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: { state: "cancelled" },
      });
    }).pipe(Effect.scoped),
  );
});

function recordingAdapter(
  calls: string[],
  name: string,
): ProviderAdapterShape<ProviderAdapterError> {
  const live = new Set<ThreadId>();
  const record = (method: string) => Effect.sync(() => void calls.push(`${name}.${method}`));
  return {
    provider: ProviderDriverKind.make("cursor"),
    capabilities: { sessionModelSwitch: "in-session" },
    compaction: { type: "slash-command", command: "/compress" },
    startSession: (input) =>
      record("startSession").pipe(
        Effect.tap(() => Effect.sync(() => live.add(input.threadId))),
        Effect.as({ threadId: input.threadId } as ProviderSession),
      ),
    sendTurn: (input) =>
      record("sendTurn").pipe(Effect.as({ threadId: input.threadId, turnId: TurnId.make("t") })),
    interruptTurn: () => record("interruptTurn"),
    respondToRequest: () => record("respondToRequest"),
    respondToUserInput: () => record("respondToUserInput"),
    stopSession: () => record("stopSession"),
    listSessions: () => Effect.succeed([]),
    hasSession: (threadId) => Effect.sync(() => live.has(threadId)),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}

it.effect("routes each Cursor thread to the CLI or the cloud for its whole life", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const adapter = routeCursorExecution(
      recordingAdapter(calls, "local"),
      recordingAdapter(calls, "cloud"),
    );
    const local = ThreadId.make("thread-local");
    const cloud = ThreadId.make("thread-cloud");
    const resumed = ThreadId.make("thread-resumed");

    yield* adapter.startSession({ threadId: local, runtimeMode: "full-access" });
    yield* adapter.startSession({
      threadId: cloud,
      runtimeMode: "full-access",
      executionTarget: "cloud",
    });
    // Recovery passes only the persisted cursor, which identifies a cloud thread by itself.
    yield* adapter.startSession({
      threadId: resumed,
      runtimeMode: "full-access",
      resumeCursor: { schemaVersion: 1, kind: "cloud", agentId: "bc-1" },
    });
    yield* adapter.sendTurn({ threadId: local, input: "hi" });
    yield* adapter.interruptTurn(cloud);
    const compacted = yield* Effect.flip(adapter.sendTurn({ threadId: cloud, input: "/compress" }));

    expect(calls).toEqual([
      "local.startSession",
      "cloud.startSession",
      "cloud.startSession",
      "local.sendTurn",
      "cloud.interruptTurn",
    ]);
    expect(compacted.message).toMatch(/cannot be compacted/);
  }),
);
