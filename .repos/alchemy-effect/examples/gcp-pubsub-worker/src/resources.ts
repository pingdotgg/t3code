import * as GCP from "alchemy/GCP";

/**
 * The queue. The API publishes one message per job; the worker pool's
 * pull subscription (created for it by `GCP.Run.TopicPullEventSource`)
 * holds each message until the worker acks it.
 */
export const Jobs = GCP.PubSub.Topic("Jobs", {});

/**
 * Job results, one document per job at `jobs/{id}`. The worker writes it
 * when a job finishes; the API reads it to answer status polls.
 */
export const Results = GCP.Firestore.Database("Results", {
  type: "FIRESTORE_NATIVE",
});

/** What the API publishes and the worker consumes. */
export interface JobMessage {
  id: string;
  payload: string;
  submittedAt: string;
}

/** The document the worker writes at `jobs/{id}`. */
export interface JobResult {
  status: "done";
  /** Hex SHA-256 of the UTF-8 payload. */
  sha256: string;
  /** Whitespace-separated word count. */
  words: number;
  /** Payload length in characters. */
  chars: number;
  submittedAt: string;
  completedAt: string;
}

/** Firestore path of a job's result document. */
export const resultPath = (id: string) => `jobs/${id}`;
