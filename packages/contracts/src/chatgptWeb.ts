import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

// Settings forms currently store numeric input as text. Decode and validate it
// here as well as in the server, so invalid limits cannot disable throttling.
const limit = (value: string, maximum: number, title: string, description: string) =>
  TrimmedString.check(
    Schema.isPattern(/^[1-9]\d*$/),
    Schema.makeFilter((s) => Number(s) <= maximum),
  ).pipe(
    Schema.withDecodingDefault(Effect.succeed(value)),
    Schema.annotateKey({ title, description, providerSettingsForm: { placeholder: value } }),
  );

export const ChatGPTWebSettings = Schema.Struct({
  minimumIntervalSeconds: limit(
    "60",
    3600,
    "Minimum seconds between requests",
    "Applies to every model request, including tool steps. Requests wait for this interval.",
  ),
  requestsPerHour: limit(
    "20",
    1000,
    "Requests per hour",
    "Rolling limit shared by this environment's ChatGPT provider. Reaching it stops the turn.",
  ),
  requestsPerDay: limit(
    "100",
    10000,
    "Requests per day",
    "Rolling 24-hour limit. Attempts count even when they fail. Limits reduce traffic but cannot guarantee account safety.",
  ),
  cooldownMinutes: limit(
    "30",
    1440,
    "Cooldown after service errors (minutes)",
    "Stops new requests after a challenge, rejected request, or service limit. Never automatically retries a blocked message.",
  ),
  binaryPath: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("opencode")),
    Schema.annotateKey({
      title: "OpenCode executable",
      description: "Provides local file tools and approvals. Model requests use ChatGPT web.",
      providerSettingsForm: { placeholder: "opencode" },
    }),
  ),
});
export type ChatGPTWebSettings = typeof ChatGPTWebSettings.Type;
