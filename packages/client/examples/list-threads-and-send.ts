/**
 * Pairs with T3 Code environments, lists their threads, and sends a message.
 *
 *   T3_PAIRING_URL=<link> node examples/list-threads-and-send.ts pair <credential-file>
 *   node examples/list-threads-and-send.ts list <credential-file>...
 *   node examples/list-threads-and-send.ts send <credential-file> <thread-id> <text>
 *
 * Credential files hold a bearer token: `pair` creates them with mode 0600,
 * refuses to overwrite an existing path, and never prints them. Revoke one from Settings > Connections.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  connect,
  decodeCredential,
  encodeCredential,
  nodeRuntimeLayer,
  pair,
} from "@t3tools/client";
import { ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { writeCredentialFile } from "./credential-file.ts";

const READY_TIMEOUT = "30 seconds";

const readCredential = Effect.fn("example.readCredential")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* decodeCredential(yield* fs.readFileString(path));
});

const pairCommand = Effect.fn("example.pair")(function* (path: string) {
  const pairingUrl = process.env.T3_PAIRING_URL;
  if (!pairingUrl) return yield* Effect.die(new Error("Set T3_PAIRING_URL to a pairing link."));
  const credential = yield* pair({ pairingUrl, label: "list-threads-and-send example" });
  const encoded = yield* encodeCredential(credential);
  yield* writeCredentialFile(path, encoded);
  yield* Console.log(`Paired with ${credential.label} (${credential.environmentId}).`);
});

const listCommand = Effect.fn("example.list")(function* (paths: ReadonlyArray<string>) {
  // One connection per environment, all open at once.
  const environments = yield* Effect.forEach(paths, (path) =>
    readCredential(path).pipe(Effect.flatMap((credential) => connect(credential))),
  );
  for (const environment of environments) {
    const { environment: server, scopes } = yield* environment.negotiation.pipe(
      Effect.timeout(READY_TIMEOUT),
    );
    yield* Console.log(
      `${server.label} (${server.environmentId}) server ${server.serverVersion}, protocol ${
        server.orchestrationProtocolVersion ?? 1
      }, scopes ${scopes?.join(" ") ?? "unreported"}`,
    );
    const shell = yield* environment.shell;
    for (const thread of shell.threads) {
      yield* Console.log(`  ${thread.id}  ${thread.title}`);
    }
  }
});

const sendCommand = Effect.fn("example.send")(function* (
  path: string,
  threadId: string,
  text: string,
) {
  const environment = yield* readCredential(path).pipe(Effect.flatMap((c) => connect(c)));
  yield* environment.ready.pipe(Effect.timeout(READY_TIMEOUT));
  const sent = yield* environment.sendMessage({ threadId: ThreadId.make(threadId), text });
  yield* Console.log(`Sent message ${sent.messageId} (command ${sent.commandId}).`);
});

const [command, ...args] = process.argv.slice(2);
const program = Effect.gen(function* () {
  if (command === "pair" && args[0]) return yield* pairCommand(args[0]);
  if (command === "list" && args.length > 0) return yield* listCommand(args);
  if (command === "send" && args[0] && args[1] && args.length >= 3) {
    return yield* sendCommand(args[0], args[1], args.slice(2).join(" "));
  }
  return yield* Effect.die(
    new Error("Usage: pair <file> | list <file>... | send <file> <thread> <text>"),
  );
});

program.pipe(
  Effect.scoped,
  Effect.provide(Layer.merge(nodeRuntimeLayer, NodeServices.layer)),
  NodeRuntime.runMain,
);
