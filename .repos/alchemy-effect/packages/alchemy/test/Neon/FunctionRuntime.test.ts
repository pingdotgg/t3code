import * as Alchemy from "@/index";
import { Function } from "@/Neon/Function";
import { NeonAuth } from "@/Neon/AuthProvider";
import { fromAuthProvider } from "@/Neon/Credentials";
import * as Layer from "effect/Layer";
import * as NeonApi from "@distilled.cloud/neon";
import * as Exit from "effect/Exit";
import { providers } from "@/Neon/Providers";
import { FunctionLogs } from "@/Neon/FunctionProvider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as HttpClient from "effect/http/HttpClient";
import RuntimeFunction from "./fixtures/function-effect.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: providers(),
});
const Stack = Alchemy.Stack(
  "NeonFunctionRuntime",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* RuntimeFunction;
    const main = yield* Effect.sync(
      () =>
        new URL("./fixtures/function-native-lifecycle.ts", import.meta.url)
          .href,
    );
    const native = yield* Function("NativeLifecycle", {
      branch: { projectId: api.projectId, branchId: api.branchId },
      main,
    });
    return { url: api.url, api, native };
  }),
);
const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll(
  Effect.gen(function* () {
    const outputs = yield* Effect.exit(stack);
    yield* destroy(Stack);
    if (Exit.isFailure(outputs) || !outputs.value) return;
    const { api, native } = outputs.value;
    for (const resource of [api, native]) {
      expect(
        yield* NeonApi.getProjectBranchFunction({
          project_id: resource.projectId,
          branch_id: resource.branchId,
          slug: resource.slug,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }
    expect(
      yield* NeonApi.getProject({ project_id: api.projectId }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      ),
    ).toBe(true);
    yield* Effect.logInfo(
      "Neon lifecycle cleanup: both functions and project independently absent",
    );
  }).pipe(Effect.provide(fromAuthProvider().pipe(Layer.provide(NeonAuth)))),
);
const reportRuntimeLogs = Effect.gen(function* () {
  const { api, native } = yield* stack;
  const client = yield* HttpClient.HttpClient;
  for (const resource of [api, native]) {
    const lifecycle = yield* client
      .get(`${resource.url}diagnostics`)
      .pipe(Effect.flatMap((response) => response.json));
    yield* Effect.logInfo(
      JSON.stringify({ native: resource === native, lifecycle }),
    );
    const lines = yield* FunctionLogs(resource, { limit: 1000 });
    yield* Effect.logInfo(
      JSON.stringify({
        native: resource === native,
        functionRuntimeLogs: lines,
      }),
    );
  }
});

test(
  "Effect class preserves request isolation, streams and bodyless finalizers",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect(yield* (yield* client.get(url)).text).toBe("effect");
    const stream = yield* client.get(`${url}stream?id=stream`);
    expect(yield* stream.text).toBe("data: first\n\ndata: second\n\n");
    expect((yield* client.head(`${url}?id=head`)).status).toBe(200);
    expect((yield* client.get(`${url}empty?id=empty`)).status).toBe(204);
    const parallel = yield* Effect.all(
      Array.from({ length: 4 }, (_, i) =>
        client
          .get(`${url}slow?id=parallel${i}`)
          .pipe(Effect.flatMap((response) => response.text)),
      ),
      { concurrency: 4 },
    );
    expect(parallel).toEqual(["effect", "effect", "effect", "effect"]);
    const finalized = yield* client
      .get(`${url}finalized`)
      .pipe(Effect.flatMap((response) => response.json));
    expect(finalized).toMatchObject({ active: 0 });
    expect(finalized).toMatchObject({
      finalized: expect.arrayContaining([
        "stream",
        "head",
        "empty",
        "parallel0",
        "parallel1",
        "parallel2",
        "parallel3",
      ]),
    });
  }),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "waitUntil outlives the response with an independent request scope",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect(
      yield* (yield* client.get(`${url}background?id=background-request`)).text,
    ).toBe("scheduled");
    const completed = yield* client.get(`${url}finalized`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        times: 8,
        until: (body) => JSON.stringify(body).includes("background-work"),
      }),
    );
    expect(completed).toMatchObject({
      finalized: expect.arrayContaining([
        "background-request",
        "background-work",
      ]),
    });
  }),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

// Waits up to two minutes for durable finalizer evidence; skip under --fast.
test.provider.skipIf(!!process.env.FAST)(
  "WebSocket upgrade preserves native metadata and closes the request scope",
  () =>
    Effect.gen(function* () {
      const { url, native } = yield* stack;
      for (const [target, id] of [
        [native.url, "native-websocket"],
        [url, "websocket"],
      ]) {
        const echoed = yield* Effect.callback<string, Error>((resume) => {
          const socket = new WebSocket(
            `${target.replace(/^http/, "ws")}websocket?id=${id}`,
          );
          let message: string | undefined;
          socket.addEventListener("open", () => socket.send("native-upgrade"));
          socket.addEventListener(
            "message",
            (event) => {
              message = String(event.data);
              socket.close(1000);
            },
            { once: true },
          );
          socket.addEventListener(
            "close",
            (event) =>
              resume(
                message !== undefined && event.wasClean
                  ? Effect.succeed(message)
                  : Effect.fail(
                      new Error(
                        `Neon WebSocket closed unexpectedly (${event.code})`,
                      ),
                    ),
              ),
            { once: true },
          );
          socket.addEventListener(
            "error",
            () =>
              resume(Effect.fail(new Error("Neon WebSocket handshake failed"))),
            { once: true },
          );
          return Effect.sync(() => socket.close());
        }).pipe(Effect.timeout("15 seconds"));
        expect(echoed).toBe("native-upgrade");
      }
      const client = yield* HttpClient.HttpClient;
      const completed = yield* client.get(`${url}finalized`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (body) => JSON.stringify(body).includes("websocket"),
        }),
        Effect.timeout("2 minutes"),
      );
      const lifecycle = yield* (yield* client.get(`${native.url}diagnostics`))
        .json;
      yield* Effect.logInfo(JSON.stringify({ lifecycle }));
      expect(lifecycle).toEqual(
        expect.arrayContaining([{ id: "native-websocket", phase: "close" }]),
      );
      expect(completed).toMatchObject({
        finalized: expect.arrayContaining(["websocket"]),
      });
    }).pipe(Effect.ensuring(reportRuntimeLogs.pipe(Effect.orDie))),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 180_000,
  },
);

// Waits up to two minutes for durable finalizer evidence; skip under --fast.
test.provider.skipIf(!!process.env.FAST)(
  "cancelling a streamed response releases its request scope",
  () =>
    Effect.gen(function* () {
      const { url, native } = yield* stack;
      for (const [target, id, suffix] of [
        [native.url, "native-stream", ""],
        [url, "cancelled-stream", ""],
        [native.url, "native-sse", "&sse"],
        [url, "cancelled-sse", "&sse"],
      ]) {
        yield* Effect.gen(function* () {
          const child = yield* ChildProcess.make("curl", [
            "--silent",
            "--show-error",
            "--fail",
            "--no-buffer",
            "--http1.1",
            "--noproxy",
            "*",
            "--max-time",
            "15",
            "-H",
            "Connection: close",
            `${target}stream-cancel?id=${id}${suffix}`,
          ]);
          const first = yield* child.stdout.pipe(
            Stream.decodeText,
            Stream.filter((chunk) => chunk.includes("tick")),
            Stream.runHead,
            Effect.timeout("10 seconds"),
          );
          expect(Option.isSome(first)).toBe(true);
          // Terminating the client proves the transport closed, not just its reader.
          if (yield* child.isRunning) yield* child.kill();
          expect(yield* child.isRunning).toBe(false);
        }).pipe(Effect.scoped);
      }
      const client = yield* HttpClient.HttpClient;
      const completed = yield* client.get(`${url}finalized`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (body) =>
            ["cancelled-stream", "cancelled-sse"].every((id) =>
              JSON.stringify(body).includes(id),
            ),
        }),
        Effect.timeout("2 minutes"),
      );
      const lifecycle = (yield* (yield* client.get(`${native.url}diagnostics`))
        .json) as { id: string; phase: string }[];
      yield* Effect.logInfo(JSON.stringify({ lifecycle }));
      for (const id of ["native-stream", "native-sse"]) {
        expect(lifecycle).toEqual(
          expect.arrayContaining([{ id, phase: "entered" }]),
        );
        expect(
          lifecycle.some(
            (row) =>
              row.id === id &&
              (row.phase === "abort" || row.phase === "cancel"),
          ),
        ).toBe(true);
      }
      expect(completed).toMatchObject({
        finalized: expect.arrayContaining([
          "cancelled-stream",
          "cancelled-sse",
        ]),
      });
    }).pipe(Effect.ensuring(reportRuntimeLogs.pipe(Effect.orDie))),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 180_000,
  },
);

test(
  "Effect defects produce non-success responses without leaking errors",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${url}error`);
    expect(response.status).toBe(500);
    expect(yield* response.text).not.toContain("intentional");
  }),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
