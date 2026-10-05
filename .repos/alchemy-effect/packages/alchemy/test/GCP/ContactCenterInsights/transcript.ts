import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const CHAT_TRANSCRIPT = JSON.stringify({
  entries: [
    {
      start_timestamp_usec: 1_000_000,
      text: "Hello, how can I help you today?",
      role: "AGENT",
      user_id: 1,
    },
    {
      start_timestamp_usec: 5_000_000,
      text: "I want to check my billing.",
      role: "CUSTOMER",
      user_id: 2,
    },
  ],
});

export const uploadChatTranscript = (bucketName: string) =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const token = Redacted.value(env.accessToken);
    const project = env.project;
    yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(project)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: bucketName,
              location: "US-CENTRAL1",
            }),
          },
        ),
      catch: (error) =>
        new Error(`transcript bucket create failed: ${String(error)}`),
    });
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=transcript.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: CHAT_TRANSCRIPT,
          },
        ),
      catch: (error) => new Error(`transcript upload failed: ${String(error)}`),
    });
    if (!response.ok) {
      return yield* Effect.die(
        new Error(`transcript upload failed with HTTP ${response.status}`),
      );
    }
  });

/**
 * A bucket holding {@link CHAT_TRANSCRIPT}, declared as stack resources.
 * Conversations must name a GCS transcript as their data source.
 */
export const ChatTranscript = Effect.gen(function* () {
  const bucket = yield* GCP.Storage.Bucket("Transcripts", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  const object = yield* GCP.Storage.Object("Transcript", {
    bucketName: bucket.bucketName,
    key: "transcript.json",
    content: CHAT_TRANSCRIPT,
    contentType: "application/json",
  });
  return {
    gcsSource: {
      transcriptUri: Output.interpolate`gs://${bucket.bucketName}/${object.key}`,
    },
  };
});
