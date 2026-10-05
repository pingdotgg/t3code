import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { uploadChatTranscript } from "./transcript.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const transcriptBucketOf = (project: string) =>
  `alchemy-cci-transcripts-${project}`;
const conversationId = "alchemy-cci-assess-conv";
const conversationNameOf = (project: string) =>
  `projects/${project}/locations/us-central1/conversations/${conversationId}`;

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsConversationsAssessments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const ensureConversation = (project: string) =>
  Effect.gen(function* () {
    const transcriptBucket = transcriptBucketOf(project);
    const conversationName = conversationNameOf(project);
    yield* uploadChatTranscript(transcriptBucket);
    const existing = yield* cci
      .getProjectsLocationsConversations({
        name: conversationName,
        view: "BASIC",
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing !== undefined) return existing;
    return yield* cci.createProjectsLocationsConversations({
      parent: `projects/${project}/locations/us-central1`,
      conversationId,
      body: {
        medium: "CHAT",
        languageCode: "en-US",
        labels: { "alchemy-test": "cci" },
        dataSource: {
          gcsSource: {
            transcriptUri: `gs://${transcriptBucket}/transcript.json`,
          },
        },
      },
    });
  });

const deleteConversation = (project: string) =>
  cci
    .deleteProjectsLocationsConversations({
      name: conversationNameOf(project),
      force: true,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

test.provider(
  "getProjectsLocationsConversationsAssessments on a missing assessment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const conversationName = conversationNameOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsConversationsAssessments({
          name: `${conversationName}/assessments/missing`,
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

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a conversation assessment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const conversationName = conversationNameOf(project);
      yield* stack.destroy();
      const conversation = yield* ensureConversation(project);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.ConversationsAssessment(
            "QA",
            {
              parent: conversation.name ?? conversationName,
              agentInfo: {
                agentId: "agent-1",
                displayName: "Ada",
                agentType: "HUMAN_AGENT",
              },
            },
          );
        }),
      );

      expect(created.name).toContain("/assessments/");
      expect(created.agentInfo?.displayName).toEqual("Ada");

      const fetched = yield* cci.getProjectsLocationsConversationsAssessments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.agentInfo?.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.ConversationsAssessment(
            "QA",
            {
              parent: conversation.name ?? conversationName,
              agentInfo: {
                agentId: "agent-1",
                displayName: "Bob",
                agentType: "HUMAN_AGENT",
              },
            },
          );
        }),
      );
      expect(updated.agentInfo?.displayName).toEqual("Bob");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
      yield* deleteConversation(project);
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 120_000,
  },
);
