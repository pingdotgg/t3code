/**
 * CursorAccountReader - reads one range of Cursor account usage from its
 * dashboard API. A service so tests can stand in for Cursor's API.
 *
 * @module provider-cursor/server/CursorAccountReader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import type { CursorCredentialSource } from "./accountCache.ts";
import { readCursorAccountUsage, type CursorAccountUsageReadResult } from "./accountUsage.ts";
import * as CursorKeychain from "./CursorKeychain.ts";

export class CursorAccountReader extends Context.Service<
  CursorAccountReader,
  {
    readonly read: (
      credentialSource: CursorCredentialSource,
      sinceMs: number,
      untilMs: number,
    ) => Effect.Effect<CursorAccountUsageReadResult>;
  }
>()("@t3tools/provider-cursor/server/CursorAccountReader") {}

/** Reads Cursor's dashboard API with the saved CLI or Keychain login. */
export const layer = Layer.effect(
  CursorAccountReader,
  Effect.gen(function* () {
    const keychain = yield* CursorKeychain.CursorKeychain;
    return CursorAccountReader.of({
      read: (credentialSource, sinceMs, untilMs) =>
        Effect.gen(function* () {
          // Only a Keychain login asks the Keychain. The dashboard reader
          // turns its outcome, a failure included, into the source's message.
          const token =
            typeof credentialSource === "string"
              ? Result.succeed(null)
              : yield* Effect.result(keychain.accessToken);
          return yield* Effect.promise(() =>
            readCursorAccountUsage(credentialSource, sinceMs, untilMs, globalThis.fetch, () =>
              Result.isSuccess(token)
                ? Promise.resolve(token.success)
                : Promise.reject(token.failure),
            ),
          );
        }),
    });
  }),
);
