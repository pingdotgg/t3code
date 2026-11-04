import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import * as CodexError from "./errors.ts";

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

  it.effect("warns once about a notification that fails to decode and keeps dispatching", () =>
    Effect.gen(function* () {
      const secret = "codex-notification-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const warnings: Array<unknown> = [];
      const client = yield* CodexClient.make(stdio).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, fiber }) => {
              if (logLevel === "Warn")
                warnings.push(fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );
      const delivered = yield* Deferred.make<unknown>();
      yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
        Deferred.succeed(delivered, payload).pipe(Effect.asVoid),
      );

      const send = (params: unknown) =>
        Queue.offer(
          input,
          new TextEncoder().encode(
            `${JSON.stringify({ method: "item/agentMessage/delta", params })}\n`,
          ),
        );
      const malformed = { itemId: "item-1", threadId: "thread-1", turnId: secret };
      yield* send(malformed);
      yield* send(malformed);
      yield* send({ delta: "ok", itemId: "item-1", threadId: "thread-1", turnId: "turn-1" });

      assert.deepEqual(yield* Deferred.await(delivered), {
        delta: "ok",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      assert.lengthOf(warnings, 1);
      expect(warnings[0]).toMatchObject({
        operation: "decode-notification-payload",
        method: "item/agentMessage/delta",
        issueKinds: expect.arrayContaining(["MissingKey"]),
      });
      assert.notInclude(JSON.stringify(warnings), secret);
    }),
  );

  it.effect("a dying notification handler leaves no request waiting on a live app-server", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle();
      const client = yield* Layer.build(CodexClient.layerChildProcess(handle)).pipe(
        Effect.flatMap((context) =>
          Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
        ),
      );
      // A Codex error type must still surface as a transport failure, not as Codex's answer.
      const handlerFailure = CodexError.CodexAppServerRequestError.internalError("Injected");
      yield* client.handleServerNotification("error", () =>
        Effect.fail(handlerFailure).pipe(Effect.orDie),
      );
      const termination = yield* client.awaitTermination.pipe(Effect.flip, Effect.forkScoped);

      // The peer answers right after this notification and stays alive, so only the reader's
      // own termination can settle the request.
      const failure = yield* client.raw
        .request("mock/notifyThenRespond", {
          notification: {
            method: "error",
            params: {
              error: {
                message: "Fatal error: application network permission was revoked",
                codexErrorInfo: "other",
                additionalDetails: null,
              },
              willRetry: false,
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => assert.fail("Expected the dead reader to fail the request"),
          }),
        );

      assert.instanceOf(failure, CodexError.CodexAppServerTransportError);
      assert.equal(failure.operation, "read-input-stream");
      assert.strictEqual(failure.cause, handlerFailure);
      assert.strictEqual(yield* Fiber.join(termination), failure);
      assert.strictEqual(
        yield* client.raw.request("thread/read", {}).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => assert.fail("Expected the retired transport to reject requests"),
          }),
        ),
        failure,
      );
      // Retiring the transport closes the app-server's stdin, so it does not live on unread.
      assert.equal(yield* handle.exitCode, 0);
    }),
  );
});

it.live("reports the stderr error when the process exits before initialize", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        'throw new Error("Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest")',
      ]),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(CodexClient.layerChildProcess(handle), scope);

    const error = yield* Effect.gen(function* () {
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
    }).pipe(Effect.flip, Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

    assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
    assert.equal(
      error.message,
      "Codex App Server process exited with code 1: Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
