import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { ChatTranscript } from "./transcript.ts";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsConversations({ name, view: "BASIC" }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsConversations on a missing conversation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsConversations({
          name: `projects/${project}/locations/us-central1/conversations/alchemy-missing-conv`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a conversation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.Conversation("Chat", {
            dataSource: yield* ChatTranscript,
            medium: "CHAT",
            languageCode: "en-US",
            agentId: "agent-1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.conversationId).toEqual(expect.any(String));
      expect(created.name).toContain("/conversations/");
      expect(created.location).toEqual("us-central1");
      expect(created.medium).toEqual("CHAT");
      expect(created.agentId).toEqual("agent-1");
      expect(created.languageCode).toEqual("en-US");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* cci.getProjectsLocationsConversations({
        name: created.name,
        view: "BASIC",
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.agentId).toEqual("agent-1");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.Conversation("Chat", {
            dataSource: yield* ChatTranscript,
            conversationId: created.conversationId,
            location: "us-central1",
            medium: "CHAT",
            languageCode: "en-GB",
            agentId: "agent-2",
            labels: { env: "prod", role: "chat" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.agentId).toEqual("agent-2");
      expect(updated.languageCode).toEqual("en-GB");
      expect(updated.labels).toMatchObject({ env: "prod", role: "chat" });

      const fetchedUpdate = yield* cci.getProjectsLocationsConversations({
        name: updated.name,
        view: "BASIC",
      });
      expect(fetchedUpdate.agentId).toEqual("agent-2");
      expect(fetchedUpdate.languageCode).toEqual("en-GB");
      expect(fetchedUpdate.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
