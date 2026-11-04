import crypto from "node:crypto";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

export { PageView, PageViews, pageViewFields } from "./pipelines-stream.ts";

/** The active API token (live tests run with an apiToken profile). */
export const apiToken = Effect.gen(function* () {
  const creds = yield* yield* CloudflareEnvironment;
  if (creds.type !== "apiToken") {
    return yield* Effect.die(new Error("Basin Pipelines tests require an apiToken profile"));
  }
  return creds.apiToken;
});

/**
 * R2 S3-compatible credentials derived from the active API token: the
 * access key id is the token id, the secret the SHA-256 hex of its value.
 */
export const r2Credentials = Effect.gen(function* () {
  const token = yield* apiToken;
  const { accountId } = yield* yield* CloudflareEnvironment;
  // Account-owned tokens (`cfat_…`) verify against the account route.
  const verified = yield* Redacted.value(token).startsWith("cfat_")
    ? accounts.verifyToken({ accountId })
    : user.verifyToken({}).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
  const secretAccessKey = yield* Effect.sync(() =>
    crypto.createHash("sha256").update(Redacted.value(token)).digest("hex"),
  );
  return {
    accessKeyId: Redacted.make(verified.id),
    secretAccessKey: Redacted.make(secretAccessKey),
  };
});
