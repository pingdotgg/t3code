import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

/** Turn a room's messages into a one-paragraph summary (stands in for an LLM call). */
export const summarize = (room: string) => Effect.succeed(`Summary of ${room}`);

/** The same two steps as Lambda functions, for the Step Functions version. */
export const Summarize = AWS.Lambda.Function(
  "Summarize",
  { main: import.meta.url },
  Effect.succeed({}),
);
export const SaveDigest = AWS.Lambda.Function(
  "SaveDigest",
  { main: import.meta.url },
  Effect.succeed({}),
);
