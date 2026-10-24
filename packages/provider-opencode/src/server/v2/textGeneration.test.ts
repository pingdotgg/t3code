import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCode2TextGeneration from "./textGeneration.ts";

const SESSION_ID = "ses_explain";
const modelSelection = createModelSelection(
  ProviderInstanceId.make("opencode"),
  "opencode/big-pickle",
);
const explainInput = { context: "Message: spawn opencode ENOENT", modelSelection };

type Emitted = { readonly type: string; readonly data: Record<string, unknown> };

/**
 * An OpenCode 2 server that answers each prompt with `reply`'s events, and
 * records what T3 asked of it.
 */
const makeFakeServer = (reply: ReadonlyArray<Emitted>) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Emitted>();
    const calls = {
      created: [] as Array<{ directory: string; permissions: unknown }>,
      prompts: [] as string[],
      permissionReplies: [] as Array<{ requestID: string; decision: string }>,
      removed: [] as string[],
    };
    const client = {
      session: {
        create: (input: { location: { directory: string }; permissions: unknown }) =>
          Effect.sync(() => {
            calls.created.push({
              directory: input.location.directory,
              permissions: input.permissions,
            });
            return { id: SESSION_ID };
          }),
        prompt: (input: { text: string }) =>
          Effect.gen(function* () {
            calls.prompts.push(input.text);
            yield* Queue.offerAll(events, reply);
          }),
        remove: (input: { sessionID: string }) =>
          Effect.sync(() => {
            calls.removed.push(input.sessionID);
          }),
        interrupt: () => Effect.void,
      },
      permission: {
        reply: (input: { requestID: string; decision: string }) =>
          Effect.sync(() => {
            calls.permissionReplies.push({
              requestID: input.requestID,
              decision: input.decision,
            });
          }),
      },
    };
    const connection = {
      url: "http://127.0.0.1:4096",
      version: "2.0.18",
      external: true,
      client,
      events: Effect.succeed(Stream.fromQueue(events)),
    } as unknown as OpenCode2Server.OpenCode2Connection;
    const server: OpenCode2Server.OpenCode2Server["Service"] = {
      withConnection: (use) => use(connection),
    };
    return { server, calls };
  });

const makeTextGeneration = (server: OpenCode2Server.OpenCode2Server["Service"]) =>
  OpenCode2TextGeneration.make().pipe(
    Effect.provideService(OpenCode2Server.OpenCode2Server, server),
    Effect.provideService(ProviderHost.ProviderHost, {
      resolveAttachmentPath: () => null,
    } as unknown as ProviderHost.ProviderHost["Service"]),
  );

const text = (value: string): Emitted => ({
  type: "session.text.ended",
  data: { sessionID: SESSION_ID, assistantMessageID: "msg_1", ordinal: 0, text: value },
});
const succeeded: Emitted = {
  type: "session.execution.succeeded",
  data: { sessionID: SESSION_ID },
};

it.layer(NodeServices.layer)("OpenCode2TextGeneration.explainProviderFailure", (it) => {
  it.effect("runs in a removed empty temp directory, rejects tools and bounds the answer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fake = yield* makeFakeServer([
        { type: "permission.asked", data: { sessionID: SESSION_ID, id: "per_1" } },
        text('{"summary":"  OpenCode is not installed. ","likelyFix":" Install OpenCode. "}'),
        succeeded,
      ]);
      const textGeneration = yield* makeTextGeneration(fake.server);

      const explained = yield* textGeneration.explainProviderFailure(explainInput);

      assert.deepEqual(explained, {
        summary: "OpenCode is not installed.",
        likelyFix: "Install OpenCode.",
        matchingIssueNumber: null,
      });
      const directory = fake.calls.created[0]?.directory ?? "";
      assert.include(directory, "t3code-text-generation-");
      assert.notEqual(directory, process.cwd());
      // The directory belonged to the request's scope, which has closed.
      assert.isFalse(yield* fileSystem.exists(directory));
      assert.deepEqual(fake.calls.created[0]?.permissions, [
        { action: "*", resource: "*", effect: "ask" },
      ]);
      assert.deepEqual(fake.calls.permissionReplies, [{ requestID: "per_1", decision: "reject" }]);
      assert.include(fake.calls.prompts[0], "spawn opencode ENOENT");
      assert.deepEqual(fake.calls.removed, [SESSION_ID]);
    }),
  );

  it.effect("rejects an answer without the structured fields and removes the session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeServer([text('{"summary":"Only half an answer."}'), succeeded]);
      const textGeneration = yield* makeTextGeneration(fake.server);

      const error = yield* textGeneration.explainProviderFailure(explainInput).pipe(Effect.flip);

      assert.strictEqual(error._tag, "TextGenerationError");
      assert.strictEqual(error.operation, "explainProviderFailure");
      assert.strictEqual(error.detail, "OpenCode returned invalid structured output.");
      assert.deepEqual(fake.calls.removed, [SESSION_ID]);
    }),
  );

  it.effect("reports a failed execution and still cleans up", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fake = yield* makeFakeServer([
        {
          type: "session.execution.failed",
          data: { sessionID: SESSION_ID, error: { message: "model unavailable" } },
        },
      ]);
      const textGeneration = yield* makeTextGeneration(fake.server);

      const error = yield* textGeneration.explainProviderFailure(explainInput).pipe(Effect.flip);

      assert.strictEqual(error.detail, "OpenCode could not generate the text.");
      assert.deepEqual(fake.calls.removed, [SESSION_ID]);
      assert.isFalse(yield* fileSystem.exists(fake.calls.created[0]?.directory ?? ""));
    }),
  );
});
