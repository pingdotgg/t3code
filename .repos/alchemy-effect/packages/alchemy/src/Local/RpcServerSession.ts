import { RpcSession, type RpcCompatible, type RpcTransport } from "capnweb";

/**
 * A platform-agnostic interface for a server-side WebSocket.
 */
export interface ServerWebSocketLike {
  send: (message: string) => any | Promise<any>;
  close: (code?: number, reason?: string) => void;
}

/**
 * Represents a websocket RPC session with capnweb.
 * Use the `dispatch` object to handle messages that are received from the client.
 */
export type ServerRpcSession<T extends RpcCompatible<T>> = ReturnType<
  typeof makeServerRpcSession<T>
>;

/**
 * Constructs a ServerRpcSession using capnweb.
 * @param ws - The WebSocket to use for the session.
 * @param main - The main object to use for the session.
 * @returns A ServerRpcSession.
 */
export function makeServerRpcSession<T extends RpcCompatible<T>>(
  ws: ServerWebSocketLike,
  main: T,
) {
  const { transport, dispatch } = makeWebSocketRpcTransport(ws);
  const session = new RpcSession(transport, main);
  return { session, dispatch };
}

function makeWebSocketRpcTransport(ws: ServerWebSocketLike) {
  let receiveQueue: Array<string> = [];
  let receiveResolver: ((value: string) => void) | undefined;
  let receiveRejecter: ((reason: unknown) => void) | undefined;
  let error: unknown | undefined;
  return {
    transport: {
      send: async (message: string) => await ws.send(message),
      receive: async () => {
        const next = receiveQueue.shift();
        if (next) {
          return next;
        } else if (error) {
          throw error;
        }
        return new Promise<string>((resolve, reject) => {
          receiveResolver = resolve;
          receiveRejecter = reject;
        });
      },
      abort: (reason: unknown) => {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        ws.close(3000, message);
        error ??= reason;
      },
    } satisfies RpcTransport,
    dispatch: {
      message: (data: string | Buffer<ArrayBuffer>) => {
        if (error) {
          return;
        }
        data = typeof data === "string" ? data : data.toString("utf-8");
        if (receiveResolver) {
          receiveResolver(data);
          receiveResolver = undefined;
          receiveRejecter = undefined;
        } else {
          receiveQueue.push(data);
        }
      },
      close: (code: number, reason: string) => {
        if (!error) {
          error = new Error(`WebSocket closed with code ${code}: ${reason}`);
          if (receiveRejecter) {
            receiveRejecter(error);
            receiveRejecter = undefined;
            receiveResolver = undefined;
          }
        }
      },
    },
  };
}
