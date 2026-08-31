import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The line-delimited JSON contract between the React Native side and the Bare
 * P2P worklet (`worklet/p2p-worklet-core.mjs`). Every message is one JSON
 * object per `\n`-terminated line; the worklet answers a `dial`/`close`
 * command with the reply carrying the same `id`.
 */
export const P2pWorkletCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("dial"),
    id: Schema.String,
    publicKeyZ32: Schema.String,
    /** DHT bootstrap nodes as host:port entries; empty means the public DHT. */
    bootstrap: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("close"),
    id: Schema.String,
    publicKeyZ32: Schema.String,
  }),
]);
export type P2pWorkletCommand = typeof P2pWorkletCommand.Type;

export const P2pWorkletReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("listening"),
    id: Schema.String,
    publicKeyZ32: Schema.String,
    port: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("dial-error"),
    id: Schema.String,
    publicKeyZ32: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    id: Schema.String,
    publicKeyZ32: Schema.String,
    closed: Schema.Boolean,
  }),
]);
export type P2pWorkletReply = typeof P2pWorkletReply.Type;

const encodeCommand = Schema.encodeSync(Schema.fromJsonString(P2pWorkletCommand));

export const encodeP2pWorkletCommand = (command: P2pWorkletCommand): string =>
  `${encodeCommand(command)}\n`;

const decodeReplyLine = decodeJsonResult(P2pWorkletReply);

/**
 * Stateful reply decoder: feed it IPC chunks in arrival order and it yields
 * every complete, well-formed reply line. Partial lines stay buffered until
 * their newline arrives; malformed lines are dropped (the worklet is ours, so
 * a bad line means a version skew, not an attacker).
 */
export const createP2pWorkletReplyDecoder = (): ((chunk: string) => Array<P2pWorkletReply>) => {
  let buffered = "";
  return (chunk) => {
    buffered += chunk;
    const replies: Array<P2pWorkletReply> = [];
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line.length === 0) {
        continue;
      }
      const decoded = decodeReplyLine(line);
      if (Result.isSuccess(decoded)) {
        replies.push(decoded.success);
      }
    }
    return replies;
  };
};
