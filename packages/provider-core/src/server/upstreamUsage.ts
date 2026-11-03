import {
  UsageLimitSourceError,
  type ProviderDriverKind,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeUnavailableUsageLimits } from "./usageLimits.ts";

export interface StoredUpstreamCredential {
  readonly providerId: string;
  /** Pi stores API keys as "api_key"; OpenCode stores them as "api". */
  readonly authType: "api_key" | "api";
  readonly secret?: string;
}

export interface UpstreamUsageReaderContext {
  readonly driver: ProviderDriverKind;
  readonly credential: StoredUpstreamCredential;
  readonly checkedAt: string;
}

export type UpstreamUsageReader<R = never> = (
  context: UpstreamUsageReaderContext,
) => Effect.Effect<UsageLimitSourceAccount, UsageLimitSourceError, R>;

// Secrets stay in the returned credential and are never logged or embedded in errors.
const UpstreamAuthEntry = Schema.Struct({
  type: Schema.Literals(["api_key", "api"]),
  key: Schema.optional(Schema.String),
});
const UpstreamAuthFile = Schema.Record(Schema.String, Schema.Unknown);
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(UpstreamAuthFile));
const decodeAuthEntry = Schema.decodeUnknownOption(UpstreamAuthEntry);

export const discoverUpstreamCredentials = Effect.fn("discoverUpstreamCredentials")(function* (
  authPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(authPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
  );
  const authFile = yield* decodeAuthFile(contents);
  const credentials: StoredUpstreamCredential[] = [];
  for (const [providerId, stored] of Object.entries(authFile)) {
    const entry = decodeAuthEntry(stored);
    if (Option.isNone(entry)) continue;
    const trimmedId = providerId.trim();
    if (!trimmedId) continue;
    const secret = entry.value.key?.trim();
    credentials.push({
      providerId: trimmedId,
      authType: entry.value.type,
      ...(secret ? { secret } : {}),
    });
  }
  return credentials;
});

function unavailableAccount(
  context: UpstreamUsageReaderContext,
  reason: "unsupported" | "probeFailed",
  message?: string,
): UsageLimitSourceAccount {
  return {
    id: context.credential.providerId,
    driver: context.driver,
    usageLimits: makeUnavailableUsageLimits({
      checkedAt: context.checkedAt,
      reason,
      ...(message !== undefined ? { message } : {}),
    }),
  };
}

export const probeUpstreamUsage = Effect.fn("probeUpstreamUsage")(function* <R>(input: {
  readonly driver: ProviderDriverKind;
  readonly credentials: ReadonlyArray<StoredUpstreamCredential>;
  readonly readers: Readonly<Record<string, UpstreamUsageReader<R>>>;
}): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, never, R> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.forEach(input.credentials, (credential) =>
    Effect.suspend(() => {
      const context: UpstreamUsageReaderContext = {
        driver: input.driver,
        credential,
        checkedAt,
      };
      const reader = input.readers[credential.providerId];
      if (reader === undefined) {
        return Effect.succeed(unavailableAccount(context, "unsupported"));
      }
      return reader(context).pipe(
        Effect.catchCause(() =>
          Effect.succeed(
            unavailableAccount(
              context,
              "probeFailed",
              `${credential.providerId} could not read usage.`,
            ),
          ),
        ),
      );
    }),
  );
});
