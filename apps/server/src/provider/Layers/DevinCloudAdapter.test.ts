import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DevinCloudSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import type { DevinCloudApi } from "../DevinCloudApi.ts";
import { makeDevinCloudAdapter, splitDevinCloudList } from "./DevinCloudAdapter.ts";

const settings = Schema.decodeSync(DevinCloudSettings)({
  apiKey: "cog_test",
  organizationId: "org-test",
  repositories: "repo-a, repo-b\nrepo-a",
  tags: "t3-code",
});
const remoteSession = {
  session_id: "devin-session",
  status: "running" as const,
  url: "https://app.devin.ai/sessions/devin-session",
};
const TestServices = Layer.merge(
  NodeServices.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("The injected Devin Cloud API should handle every request")),
  ),
);

describe("DevinCloudAdapter", () => {
  it("normalizes comma and newline separated settings", () => {
    expect(splitDevinCloudList("one, two\none\nthree")).toEqual(["one", "two", "three"]);
  });

  it.layer(TestServices)("creates a resumable cloud task and streams its result", (it) => {
    it.effect("persists the remote session id", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const createInputs: unknown[] = [];
          const completed = yield* Deferred.make<void>();
          const api: DevinCloudApi = {
            getSelf: Effect.succeed({}),
            createSession: (input) => {
              createInputs.push(input);
              return Effect.succeed(remoteSession);
            },
            sendMessage: () => Effect.succeed(remoteSession),
            getSession: () =>
              Deferred.succeed(completed, undefined).pipe(
                Effect.as({ ...remoteSession, status: "running", status_detail: "finished" }),
              ),
            listMessages: () =>
              Effect.succeed({
                items: [{ created_at: 1, event_id: "event-1", message: "Cloud task complete" }],
                end_cursor: "cursor-1",
                has_next_page: false,
                total: 1,
              }),
          };
          const adapter = yield* makeDevinCloudAdapter(settings, {
            api,
            instanceId: ProviderInstanceId.make("devin_cloud_test"),
            pollInterval: "0 millis",
          });
          const threadId = ThreadId.make("thread-test");
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("devinCloud"),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("devin_cloud_test"),
              model: "devin-fast",
            },
          });
          const started = yield* adapter.sendTurn({ threadId, input: "Build the feature" });
          yield* Deferred.await(completed);

          expect(started.resumeCursor).toEqual({
            schemaVersion: 1,
            sessionId: "devin-session",
          });
          expect(createInputs).toEqual([
            {
              prompt: "Build the feature",
              bypassApproval: true,
              repos: ["repo-a", "repo-b"],
              tags: ["t3-code"],
              devinMode: "fast",
            },
          ]);
          expect(yield* adapter.hasSession(threadId)).toBe(true);
        }),
      ),
    );

    it.effect("continues a persisted Devin session", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const messages: Array<{ readonly sessionId: string; readonly message: string }> = [];
          const api: DevinCloudApi = {
            getSelf: Effect.succeed({}),
            createSession: () => Effect.die("createSession must not run for a resumed task"),
            sendMessage: (sessionId, message) => {
              messages.push({ sessionId, message });
              return Effect.succeed(remoteSession);
            },
            getSession: () => Effect.succeed(remoteSession),
            listMessages: () =>
              Effect.succeed({
                items: [],
                end_cursor: "cursor-existing",
                has_next_page: false,
                total: 0,
              }),
          };
          const adapter = yield* makeDevinCloudAdapter(settings, {
            api,
            pollInterval: "1 hour",
          });
          const threadId = ThreadId.make("thread-resumed");
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("devinCloud"),
            runtimeMode: "approval-required",
            resumeCursor: {
              schemaVersion: 1,
              sessionId: "devin-session",
              messageCursor: "cursor-old",
            },
          });
          const started = yield* adapter.sendTurn({ threadId, input: "Continue the task" });
          yield* adapter.interruptTurn(threadId, started.turnId);

          expect(messages).toEqual([{ sessionId: "devin-session", message: "Continue the task" }]);
          expect(started.resumeCursor).toEqual({
            schemaVersion: 1,
            sessionId: "devin-session",
            messageCursor: "cursor-existing",
          });
        }),
      ),
    );
  });
});
