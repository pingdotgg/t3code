import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";

interface RecordedCommand {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

function commandHandle(result: OpenCodeRuntime.OpenCodeCommandResult) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(result.stdout)),
    stderr: Stream.encodeText(Stream.make(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function openApi(
  promptProperty: "text" | "prompt",
  operationId: string | null = "v2.session.prompt",
) {
  return {
    paths: {
      "/api/session/{sessionID}/prompt": {
        post: {
          ...(operationId === null ? {} : { operationId }),
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SessionPrompt" },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        SessionPrompt: {
          type: "object",
          properties: { [promptProperty]: { type: "string" } },
        },
      },
    },
  };
}

function fakeRuntime(input?: {
  readonly document?: unknown;
  readonly onCommand?: (
    args: ReadonlyArray<string>,
  ) => OpenCodeRuntime.OpenCodeCommandResult | undefined;
  readonly onRequest?: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly onExecute?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>;
}) {
  const commands: RecordedCommand[] = [];
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const value = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env: NodeJS.ProcessEnv };
      };
      commands.push({
        binaryPath: value.command,
        args: value.args,
        environment: value.options.env,
      });
      return commandHandle(
        input?.onCommand?.(value.args) ??
          (value.args.join(" ") === "service start"
            ? { stdout: "http://127.0.0.1:49374\n", stderr: "", code: 0 }
            : { stdout: "private-password\n", stderr: "", code: 0 }),
      );
    }),
  );
  const httpClient = HttpClient.make((request) => {
    requests.push(request);
    if (input?.onExecute) {
      return input
        .onExecute(request)
        .pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)));
    }
    const pathname = new URL(request.url).pathname;
    const response =
      pathname === "/openapi.json"
        ? Response.json(input?.document ?? openApi("text"))
        : (input?.onRequest?.(request) ?? Response.json({ ok: true }));
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return {
    commands,
    requests,
    runtime: OpenCodeRuntime.make().pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
  };
}

it.effect("memoizes one service attachment per binary and environment", () => {
  const fake = fakeRuntime();
  return Effect.gen(function* () {
    const runtime = yield* fake.runtime;
    const first = yield* runtime.attach({
      binaryPath: "opencode2",
      environment: { PATH: "/one" },
    });
    const second = yield* runtime.attach({
      binaryPath: "opencode2",
      environment: { PATH: "/one" },
    });

    NodeAssert.equal(first, second);
    NodeAssert.deepEqual(
      fake.commands.map((command) => command.args),
      [
        ["service", "start"],
        ["service", "get", "password"],
      ],
    );
    NodeAssert.equal(
      fake.requests.filter((request) => request.url.endsWith("/openapi.json")).length,
      1,
    );

    yield* runtime.attach({
      binaryPath: "opencode2",
      environment: { PATH: "/two" },
    });
    NodeAssert.equal(fake.commands.length, 4);
  });
});

it.effect("supports the current OpenCode 2 service password command", () => {
  const fake = fakeRuntime({
    onCommand: (args) =>
      args.join(" ") === "service get password"
        ? { stdout: "", stderr: "Unknown subcommand", code: 1 }
        : undefined,
  });
  return Effect.gen(function* () {
    const runtime = yield* fake.runtime;
    yield* runtime.attach({ binaryPath: "opencode2" });

    NodeAssert.deepEqual(
      fake.commands.map((command) => command.args),
      [
        ["service", "start"],
        ["service", "get", "password"],
        ["service", "password"],
      ],
    );
  });
});

it.effect("refreshes a cached attachment when the shared service is no longer healthy", () => {
  let healthFails = false;
  const fake = fakeRuntime({
    onRequest: (request) => {
      if (new URL(request.url).pathname === "/api/health" && healthFails) {
        return Response.json({ healthy: false }, { status: 503 });
      }
      return Response.json({ healthy: true });
    },
  });
  return Effect.gen(function* () {
    const runtime = yield* fake.runtime;
    const first = yield* runtime.attach({ binaryPath: "opencode2" });
    healthFails = true;
    const second = yield* runtime.attach({ binaryPath: "opencode2" });

    NodeAssert.notEqual(first, second);
    NodeAssert.deepEqual(
      fake.commands.map((command) => command.args),
      [
        ["service", "start"],
        ["service", "get", "password"],
        ["service", "start"],
        ["service", "get", "password"],
      ],
    );
  });
});

it.effect("uses private Basic auth for typed JSON and global SSE requests", () => {
  const fake = fakeRuntime({
    onRequest: (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/event") {
        return new Response(
          'data: {"id":"evt_1",\n' +
            'data: "type":"server.connected","data":{}}\n\n' +
            'data: {"id":"evt_2","type":"session.text.delta","data":{"delta":"hi"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ value: "accepted" });
    },
  });
  return Effect.gen(function* () {
    const runtime = yield* fake.runtime;
    const connection = yield* runtime.attach({ binaryPath: "opencode2" });
    const response = yield* connection.request("POST", "/api/example", {
      operation: "example.post",
      schema: Schema.Struct({ value: Schema.String }),
      query: { count: 2 },
      body: { text: "hello" },
    });
    const events = yield* connection.globalEvents.pipe(Stream.runCollect);

    NodeAssert.deepEqual(response, { value: "accepted" });
    NodeAssert.deepEqual(
      Array.from(events).map((event) => event.type),
      ["server.connected", "session.text.delta"],
    );
    const authenticated = fake.requests.filter(
      (request) => new URL(request.url).pathname !== "/openapi.json",
    );
    NodeAssert.ok(authenticated.length >= 2);
    for (const request of authenticated) {
      NodeAssert.equal(
        request.headers.authorization,
        `Basic ${Buffer.from("opencode:private-password").toString("base64")}`,
      );
    }
    NodeAssert.equal(new URL(authenticated[0]!.url).searchParams.get("count"), "2");
  });
});

it.effect("decodes empty 204 responses against the requested schema", () => {
  const fake = fakeRuntime({
    onRequest: () => new Response(null, { status: 204 }),
  });
  return Effect.gen(function* () {
    const runtime = yield* fake.runtime;
    const connection = yield* runtime.attach({ binaryPath: "opencode2" });
    const response = yield* connection.request("POST", "/api/session/ses_1/interrupt", {
      operation: "session.interrupt",
      schema: Schema.Undefined,
    });

    NodeAssert.equal(response, undefined);
  });
});

it.effect("fails explicitly when the preview OpenAPI shape is unknown", () => {
  const fake = fakeRuntime({ document: { openapi: "3.1.0", paths: {} } });
  return Effect.gen(function* () {
    const runtime = yield* fake.runtime;
    const error = yield* Effect.flip(runtime.attach({ binaryPath: "opencode2" }));

    NodeAssert.equal(OpenCodeRuntime.isOpenCodeUnsupportedPreviewError(error), true);
    NodeAssert.equal(error.operation, "openapi.detect");
    NodeAssert.match(error.message, /preview is not supported/i);
  });
});

it.effect("times out a wedged service command", () => {
  const httpClient = HttpClient.make(() => Effect.die("HTTP should not be reached"));
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.never,
        stderr: Stream.never,
        all: Stream.never,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  return Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime.make().pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const fiber = yield* runtime.attach({ binaryPath: "opencode2" }).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 seconds");
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);

    NodeAssert.equal(OpenCodeRuntime.isOpenCodeTimeoutError(error), true);
    if (!OpenCodeRuntime.isOpenCodeTimeoutError(error)) return;
    NodeAssert.equal(error.operation, "service.start");
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));
});

it.effect("times out a wedged OpenAPI probe and releases the attachment lock", () => {
  let openApiCalls = 0;
  const fake = fakeRuntime({
    onExecute: (request) => {
      if (new URL(request.url).pathname !== "/openapi.json") {
        return Effect.succeed(Response.json({ ok: true }));
      }
      openApiCalls += 1;
      return openApiCalls === 1 ? Effect.never : Effect.succeed(Response.json(openApi("text")));
    },
  });
  return Effect.gen(function* () {
    const runtime = yield* fake.runtime;
    const first = yield* runtime
      .attach({ binaryPath: "opencode2", environment: { PATH: "/one" } })
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 seconds");
    const error = yield* Fiber.join(first).pipe(Effect.flip);

    NodeAssert.equal(OpenCodeRuntime.isOpenCodeTimeoutError(error), true);
    if (!OpenCodeRuntime.isOpenCodeTimeoutError(error)) return;
    NodeAssert.equal(error.operation, "openapi.get");

    const connection = yield* runtime.attach({
      binaryPath: "opencode2",
      environment: { PATH: "/two" },
    });
    NodeAssert.equal(connection.url, "http://127.0.0.1:49374/");
    NodeAssert.equal(openApiCalls, 2);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));
});

it("detects both adjacent preview prompt shapes", () => {
  NodeAssert.deepEqual(OpenCodeRuntime.detectOpenCodeProtocol(openApi("text")), {
    promptShape: "flat",
  });
  NodeAssert.deepEqual(OpenCodeRuntime.detectOpenCodeProtocol(openApi("prompt")), {
    promptShape: "nested",
  });
  NodeAssert.deepEqual(
    OpenCodeRuntime.detectOpenCodeProtocol(openApi("prompt", "session.prompt")),
    {
      promptShape: "nested",
    },
  );
  NodeAssert.deepEqual(OpenCodeRuntime.detectOpenCodeProtocol(openApi("prompt", null)), {
    promptShape: "nested",
  });
});
