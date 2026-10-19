import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          isBlocking: true,
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("shares transport exit with current and later waiters after a successful RPC", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* CodexClient.make(stdio);
      const response = yield* client
        .request("thread/compact/start", { threadId: "thread-1" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      const responseLine = yield* encodeJson({ id: 1, result: {} });
      yield* Queue.offer(input, new TextEncoder().encode(`${responseLine}\n`));
      assert.deepEqual(yield* Fiber.join(response), {});

      const cancelled = yield* client.waitExit.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      const waiting = yield* client.waitExit.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Queue.end(input);

      const error = yield* Fiber.join(waiting).pipe(Effect.flip);
      assert.instanceOf(error, CodexError.CodexAppServerInputStreamEndedError);
      assert.strictEqual(yield* client.waitExit.pipe(Effect.flip), error);
      assert.strictEqual(yield* client.waitExit.pipe(Effect.flip), error);
    }),
  );

  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );
});
