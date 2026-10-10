import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  PreviewStreamHostSetup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { routeLayer } from "./ServerBrowserStream.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeAuth = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  error?: EnvironmentAuth.ServerAuthCredentialError,
) => {
  const requests: string[] = [];
  const layer = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateWebSocketUpgrade: (request) => {
      requests.push(request.originalUrl);
      return error
        ? Effect.fail(error)
        : Effect.succeed({
            sessionId: AuthSessionId.make("stream-test"),
            subject: "stream-test",
            method: "bearer-access-token",
            scopes,
          });
    },
  });
  return { layer, requests };
};

const mutations = [
  { type: "resize", width: 390, height: 844 },
  { type: "mouse", action: "down", x: 10, y: 10, button: "left", buttons: 1 },
  { type: "key", action: "down", key: "Enter" },
  { type: "text", text: "reader must not type" },
  { type: "wheel", deltaY: 100 },
  { type: "navigate", url: "https://example.com" },
  { type: "history", delta: -1 },
  { type: "reload" },
  { type: "probe", x: 10, y: 10 },
  { type: "takeControl" },
  { type: "releaseControl" },
  { type: "dialog", accept: true },
  { type: "viewport", setting: { _tag: "fill" } },
];

it.effect.each([
  { hasOperateScope: false, interactive: true },
  { hasOperateScope: true, interactive: true },
  { hasOperateScope: true, interactive: false },
])("streams frames and acks while gating page mutations (%s)", ({ hasOperateScope, interactive }) =>
  Effect.gen(function* () {
    const canOperate = hasOperateScope && interactive;
    const scopes = hasOperateScope
      ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
      : [AuthOrchestrationReadScope];
    const auth = makeAuth(scopes);
    const inputs: unknown[] = [];
    const attachments: Parameters<ServerBrowser.ServerBrowser["Service"]["attachViewer"]>[0][] = [];
    const acked = Promise.withResolvers<void>();
    const frame = new Uint8Array([255, 216, 255, 217]);
    const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
    yield* Queue.offer(output, { _tag: "viewport", width: 1280, height: 800 });
    yield* Queue.offer(output, {
      _tag: "frame",
      data: frame,
      ack: Effect.sync(() => acked.resolve()),
    });
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: (input) =>
        Effect.sync(() => {
          attachments.push(input);
          return {
            output,
            input: (message) => Effect.sync(() => void inputs.push(message)),
          };
        }),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(auth.layer)),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const resource = `/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket${interactive ? "" : "&interactive=false"}`;
    const received = Promise.withResolvers<void>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(`${origin}${resource}`)),
      (socket) => Effect.sync(() => socket.close()),
    );
    socket.binaryType = "arraybuffer";
    const viewports: unknown[] = [];
    const frames: Uint8Array[] = [];
    socket.addEventListener("error", () => received.reject(new Error("stream failed")));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        viewports.push(JSON.parse(event.data));
        return;
      }
      frames.push(new Uint8Array(event.data as ArrayBuffer));
      for (const message of mutations) socket.send(JSON.stringify(message));
      socket.send("malformed input");
      socket.send(JSON.stringify({ type: "ack" }));
      received.resolve();
    });
    yield* Effect.promise(() => received.promise);
    // The ack follows every mutation on the socket, so this is also a barrier
    // proving all preceding inputs were processed, without a timing sleep.
    yield* Effect.promise(() => acked.promise);
    expect(frames).toEqual([frame]);
    expect(viewports).toEqual([{ type: "viewport", width: 1280, height: 800 }]);
    expect(inputs).toEqual(canOperate ? [...mutations, null] : []);
    expect(attachments).toEqual([
      {
        threadId: "thread",
        tabId: "tab",
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
        canOperate,
      },
    ]);
    // In particular, a one-use ticket must never be authenticated a second
    // time to discover whether this read session also has operate scope.
    expect(auth.requests).toEqual([resource]);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { scopes: [], error: undefined, status: 403 },
  { scopes: [AuthOrchestrationOperateScope], error: undefined, status: 403 },
  { scopes: [], error: new EnvironmentAuth.ServerAuthMissingCredentialError({}), status: 401 },
])("rejects unauthorized stream connections before attaching a viewer (%s)", (testCase) =>
  Effect.gen(function* () {
    const auth = makeAuth(testCase.scopes, testCase.error);
    let attachments = 0;
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => {
        attachments++;
        return Effect.die("unauthorized viewer must not attach");
      },
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routeLayer.pipe(
            Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
            Layer.provide(platformLayer),
            Layer.provideMerge(auth.layer),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const response = yield* Effect.promise(() =>
      handler.handler(
        new Request("http://t3.test/api/preview-stream/ws?threadId=thread&tabId=tab", {
          headers: { upgrade: "websocket" },
        }),
      ),
    );
    expect(response.status).toBe(testCase.status);
    expect(attachments).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("serves a tab's download only to an authorized session", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-" })}/file`;
    yield* fs.writeFileString(path, "report contents");
    const requests: Array<unknown> = [];
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: (input) =>
        Effect.sync(() => {
          requests.push(input);
          return input.downloadId === "download-1"
            ? Option.some({ path, fileName: "Q3 report.csv" })
            : Option.none();
        }),
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.die("unused"),
    });
    const serve = (scopes: ReadonlyArray<AuthEnvironmentScope>, url: string) =>
      Effect.gen(function* () {
        const handler = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              routeLayer.pipe(
                Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
                Layer.provide(platformLayer),
                Layer.provideMerge(makeAuth(scopes, undefined).layer),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        return yield* Effect.promise(() => handler.handler(new Request(url)));
      });
    const base = "http://t3.test/api/preview-stream/download?threadId=thread&tabId=tab";
    const denied = yield* serve([], `${base}&id=download-1`);
    expect(denied.status).toBe(403);
    expect(requests).toEqual([]);
    const response = yield* serve([AuthOrchestrationReadScope], `${base}&id=download-1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Q3 report.csv"',
    );
    expect(yield* Effect.promise(() => response.text())).toBe("report contents");
    const missing = yield* serve([AuthOrchestrationReadScope], `${base}&id=other`);
    expect(missing.status).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("passes uploaded files to the page's open picker and needs operate scope", () =>
  Effect.gen(function* () {
    const answers: Array<{ chooserId: string; files: Array<{ name: string; text: string }> }> = [];
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: (input) =>
        Effect.sync(() => {
          answers.push({
            chooserId: input.chooserId,
            files: input.files.map((file) => ({ name: file.name, text: file.buffer.toString() })),
          });
          return input.chooserId === "chooser-1";
        }),
      attachViewer: () => Effect.die("unused"),
    });
    const upload = (scopes: ReadonlyArray<AuthEnvironmentScope>, chooser: string) =>
      Effect.gen(function* () {
        const handler = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              routeLayer.pipe(
                Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
                Layer.provide(platformLayer),
                Layer.provideMerge(makeAuth(scopes, undefined).layer),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        const body = new FormData();
        body.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
        return yield* Effect.promise(() =>
          handler.handler(
            new Request(
              `http://t3.test/api/preview-stream/upload?threadId=thread&tabId=tab&chooser=${chooser}`,
              { method: "POST", body },
            ),
          ),
        );
      });
    expect((yield* upload([AuthOrchestrationReadScope], "chooser-1")).status).toBe(403);
    expect(answers).toEqual([]);
    expect((yield* upload([AuthOrchestrationOperateScope], "chooser-1")).status).toBe(204);
    expect(answers).toEqual([
      { chooserId: "chooser-1", files: [{ name: "notes.txt", text: "hello" }] },
    ]);
    expect((yield* upload([AuthOrchestrationOperateScope], "stale")).status).toBe(409);
  }).pipe(Effect.scoped),
);

const decodeHostSetup = Schema.decodeUnknownEffect(Schema.fromJsonString(PreviewStreamHostSetup));

it.effect.each([
  {
    error: new PreviewBrowserHost.PreviewBrowserSandboxError({
      setupCommand: "sudo t3 browser setup",
    }),
    need: "sandbox",
  },
  {
    error: new PreviewBrowserHost.PreviewBrowserLibrariesError({
      setupCommand: "sudo t3 browser setup",
      libraries: ["libnss3.so"],
    }),
    need: "libraries",
  },
])("tells viewers the command that sets up the host ($need)", ({ error, need }) =>
  Effect.gen(function* () {
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.fail(new ServerBrowser.ServerBrowserLaunchError({ cause: error })),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(makeAuth([AuthOrchestrationReadScope]).layer),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(
          `${origin}/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket`,
        );
        socket.addEventListener("close", (event) =>
          closed.resolve({ code: event.code, reason: event.reason }),
        );
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    const { code, reason } = yield* Effect.promise(() => closed.promise);
    expect(code).toBe(PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE);
    expect(yield* decodeHostSetup(reason)).toEqual({
      need,
      command: "sudo t3 browser setup",
    });
  }).pipe(Effect.scoped),
);
