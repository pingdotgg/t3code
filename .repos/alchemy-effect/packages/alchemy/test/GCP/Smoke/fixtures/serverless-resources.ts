import * as GCP from "@/GCP";

/**
 * Resources the serverless smoke is composed of, shared by the API
 * Function, the worker Function, the Job, and the test's stack program.
 * Each is declared once; every `yield*` resolves the same logical resource.
 */

/** Todos, worker results, and every consumer's markers. */
export const Store = GCP.Firestore.Database("SmokeStore", {
  location: "us-central1",
  type: "FIRESTORE_NATIVE",
});

/** Files uploaded through the API; finalize events fan out via Eventarc. */
export const Uploads = GCP.Storage.Bucket("SmokeUploads", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/** Jobs the API publishes and the worker consumes over push. */
export const Jobs = GCP.PubSub.Topic("SmokeJobs", {});

/** Scheduler job id the worker consumes (yearly: never fires on its own). */
export const SCHEDULE_ID = "SmokeTick";
export const SCHEDULE_BODY = "smoke-tick";

/** Firestore document ids cannot contain `/`. */
export const docId = (value: string) => value.replaceAll("/", "_");

/** What the API publishes to {@link Jobs}. */
export interface JobMessage {
  id: string;
  payload: string;
}
