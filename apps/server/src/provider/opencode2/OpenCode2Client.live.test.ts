/**
 * Live contract check for `@opencode/client` against a real OpenCode 2 server.
 * It re-proves that OpenCode's schemas decode under the workspace Effect
 * version, which the pnpm overrides force. Run it after bumping either side:
 *
 *   OPENCODE2_BIN=/path/to/opencode vp test run src/provider/opencode2/OpenCode2Client.live.test.ts
 *
 * The turn uses the free `opencode/big-pickle` model.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AbsolutePath, Location, Model, Provider } from "@opencode/client/effect";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Filter from "effect/Filter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const binaryPath = process.env.OPENCODE2_BIN;

const startServer = Effect.fn("OpenCode2ClientLive.startServer")(function* (binary: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode2-live-" });
  const directory = path.join(root, "work");
  yield* fs.makeDirectory(directory);
  // Non-ASCII on purpose: OpenCode decodes Basic credentials as UTF-8.
  const crypto = yield* Crypto.Crypto;
  const password = `${Base64Url.encode(yield* crypto.randomBytes(32))}-pässwörd€`;
  const child = yield* spawner.spawn(
    ChildProcess.make(binary, ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        OPENCODE_PASSWORD: password,
      },
    }),
  );
  // Stop by the PID captured at spawn, before the temp directory is removed.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      try {
        process.kill(Number(child.pid), "SIGTERM");
      } catch {
        // Already exited.
      }
    }).pipe(Effect.andThen(child.exitCode), Effect.timeout("10 seconds"), Effect.ignore),
  );
  const baseUrl = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filterMap(
      Filter.fromPredicateOption((line: string) =>
        Option.fromUndefinedOr(/server listening on\s+(https?:\/\/\S+)/i.exec(line)?.[1]),
      ),
    ),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.timeout("30 seconds"),
  );
  return { baseUrl, password, directory, pid: Number(child.pid) };
});

describe.runIf(binaryPath !== undefined)("OpenCode2Client live", () => {
  it.live(
    "reads server info, runs one turn, and pages the history",
    () =>
      Effect.gen(function* () {
        const server = yield* startServer(binaryPath!);
        const opencode = yield* OpenCode2Client.OpenCode2Client;
        const { client, events } = yield* opencode.connect({
          baseUrl: server.baseUrl,
          password: server.password,
        });

        const info = yield* client.server.info();
        assert.strictEqual(info.version, "2.0.23");
        assert.strictEqual(info.pid, server.pid);

        const session = yield* client.session.create({
          title: "t3 client live check",
          location: Location.PublicRef.make({ directory: AbsolutePath.make(server.directory) }),
          model: Model.Ref.make({
            providerID: Provider.ID.make("opencode"),
            id: Model.ID.make("big-pickle"),
          }),
        });
        const finished = yield* (yield* events).pipe(
          Stream.filter(
            (event) =>
              event.type !== "unreadable.execution.ended" &&
              event.type !== "unreadable.execution.started" &&
              (event.data as { readonly sessionID?: string }).sessionID === session.id &&
              event.type.startsWith("session.execution.") &&
              event.type !== "session.execution.started",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* client.session.prompt({
          sessionID: session.id,
          text: "Reply with exactly: OPENCODE2_CLIENT_OK",
        });
        const terminal = yield* Fiber.join(finished).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.timeout("120 seconds"),
        );
        assert.strictEqual(terminal.type, "session.execution.succeeded");

        // One message per page makes every request after the first send only a cursor.
        const history = yield* OpenCode2Client.paginate(
          { sessionID: session.id, order: "asc", limit: 1 },
          client.message.list,
        ).pipe(Stream.runCollect);
        assert.deepStrictEqual(
          history.map((message) => message.type),
          ["user", "assistant", "idle"],
        );
        const assistant = history[1];
        assert(assistant?.type === "assistant");
        const reply = assistant.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        );
        assert.include(reply.join(""), "OPENCODE2_CLIENT_OK");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          OpenCode2Client.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
          ),
        ),
      ),
    180_000,
  );
});
