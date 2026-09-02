// @effect-diagnostics nodeBuiltinImport:off - Measures the real Node HTTP and WebSocket transports.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

export class TransferHttpRequestError extends Schema.TaggedErrorClass<TransferHttpRequestError>()(
  "TransferHttpRequestError",
  {
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface HttpTransferMeasurement {
  readonly status: number;
  readonly contentEncoding: string | null;
  readonly encodedBody: Uint8Array;
  readonly encodedBodyBytes: number;
  readonly decodedBody: Uint8Array;
  readonly decodedBodyBytes: number;
  /** HTTP response bytes read from the socket, including status line and headers. */
  readonly wireBytes: number;
}

export const measureHttpGet = Effect.fn("TransferBudget.measureHttpGet")(function* (input: {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}) {
  return yield* Effect.tryPromise({
    try: () =>
      new Promise<HttpTransferMeasurement>((resolve, reject) => {
        let socketBytesBeforeResponse = 0;
        const request = NodeHttp.get(
          input.url,
          {
            agent: false,
            headers: {
              "accept-encoding": "gzip",
              connection: "close",
              ...input.headers,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () => {
              try {
                const encodedBody = Buffer.concat(chunks);
                const header = response.headers["content-encoding"];
                const contentEncoding = Array.isArray(header)
                  ? (header[0] ?? null)
                  : (header ?? null);
                const decodedBody =
                  contentEncoding === "gzip" ? NodeZlib.gunzipSync(encodedBody) : encodedBody;
                resolve({
                  status: response.statusCode ?? 0,
                  contentEncoding,
                  encodedBody,
                  encodedBodyBytes: encodedBody.byteLength,
                  decodedBody,
                  decodedBodyBytes: decodedBody.byteLength,
                  wireBytes: Math.max(0, response.socket.bytesRead - socketBytesBeforeResponse),
                });
              } catch (cause) {
                reject(cause);
              }
            });
          },
        );
        request.once("socket", (socket) => {
          socketBytesBeforeResponse = socket.bytesRead;
        });
        request.once("error", reject);
        request.setTimeout(10_000, () => {
          request.destroy(new Error(`Timed out reading ${input.url}`));
        });
      }),
    catch: (cause) => new TransferHttpRequestError({ url: input.url, cause }),
  });
});

export interface WebSocketTransferTotals {
  readonly wireBytes: number;
  readonly decodedBytes: number;
  readonly messages: number;
}

export interface WebSocketTransferRecorder {
  readonly connect: (
    url: string,
    protocols: string | string[] | undefined,
    cookie: string,
  ) => globalThis.WebSocket;
  readonly totals: () => WebSocketTransferTotals;
  readonly negotiatedExtensions: () => string;
  /** Resolves once the upgrade completes, so totals taken after it exclude the upgrade response. */
  readonly awaitOpen: Effect.Effect<void>;
}

interface NodeWebSocketWithTransport extends NodeSocket.NodeWS.WebSocket {
  readonly _socket?: {
    readonly bytesRead: number;
  };
}

function rawDataBytes(data: NodeSocket.NodeWS.RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

export function makeWebSocketTransferRecorder(): WebSocketTransferRecorder {
  let socket: NodeWebSocketWithTransport | null = null;
  // Held separately from the WebSocket so wire totals survive a close, which
  // is when a reconnect measurement reads them.
  let transport: NodeWebSocketWithTransport["_socket"] | null = null;
  let decodedBytes = 0;
  let messages = 0;
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });

  return {
    connect: (url, protocols, cookie) => {
      const nextSocket = new NodeSocket.NodeWS.WebSocket(url, protocols, {
        headers: { cookie },
        perMessageDeflate: true,
      }) as NodeWebSocketWithTransport;
      socket = nextSocket;
      nextSocket.once("open", () => {
        transport = nextSocket._socket ?? null;
        resolveOpen();
      });
      nextSocket.on("message", (data) => {
        const bytes = rawDataBytes(data);
        decodedBytes += bytes;
        messages += 1;
      });
      return nextSocket as unknown as globalThis.WebSocket;
    },
    totals: () => ({
      wireBytes: transport?.bytesRead ?? socket?._socket?.bytesRead ?? 0,
      decodedBytes,
      messages,
    }),
    negotiatedExtensions: () => socket?.extensions ?? "",
    awaitOpen: Effect.promise(() => opened).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.die(new Error("Timed out waiting for the WebSocket to open")),
      }),
    ),
  };
}

export function transferDelta(
  start: WebSocketTransferTotals,
  end: WebSocketTransferTotals,
): WebSocketTransferTotals {
  return {
    wireBytes: Math.max(0, end.wireBytes - start.wireBytes),
    decodedBytes: Math.max(0, end.decodedBytes - start.decodedBytes),
    messages: Math.max(0, end.messages - start.messages),
  };
}

export function countingWsRpcProtocolLayer(input: {
  readonly url: string;
  readonly cookie: string;
  readonly recorder: WebSocketTransferRecorder;
}) {
  const webSocketConstructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url, protocols) =>
    input.recorder.connect(url, protocols, input.cookie),
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(input.url, { openTimeout: "10 seconds" }).pipe(
        Layer.provide(webSocketConstructorLayer),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
}

export const makeCountingWsRpcClient = RpcClient.make(WsRpcGroup);
export type CountingWsRpcClient = Effect.Success<typeof makeCountingWsRpcClient>;

export interface MeasuredWsClient {
  readonly client: CountingWsRpcClient;
  readonly recorder: WebSocketTransferRecorder;
  /** Fork subscription consumers here so they stop before the socket closes. */
  readonly scope: Scope.Scope;
  /** Closes the socket now. The enclosing scope closes it otherwise. */
  readonly close: Effect.Effect<void>;
}

/**
 * Opens one WebSocket RPC client on a child of the current scope. Several
 * clients can share one test scope and still disconnect independently, which
 * a reconnect measurement needs.
 */
export const openMeasuredWsClient = Effect.fn("TransferBudget.openMeasuredWsClient")(
  function* (input: { readonly url: string; readonly cookie: string }) {
    const recorder = makeWebSocketTransferRecorder();
    const parent = yield* Effect.scope;
    const scope = yield* Scope.fork(parent);
    const protocol = yield* Layer.buildWithScope(
      countingWsRpcProtocolLayer({ url: input.url, cookie: input.cookie, recorder }),
      scope,
    );
    const client = yield* makeCountingWsRpcClient.pipe(
      Effect.provide(protocol),
      Scope.provide(scope),
    );
    yield* recorder.awaitOpen;
    return {
      client,
      recorder,
      scope,
      close: Scope.close(scope, Exit.void),
    } satisfies MeasuredWsClient;
  },
);
