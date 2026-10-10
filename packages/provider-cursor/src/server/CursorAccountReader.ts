/**
 * CursorAccountReader - reads one range of Cursor account usage from its
 * dashboard API. A service so tests can stand in for Cursor's API.
 *
 * @module provider-cursor/server/CursorAccountReader
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

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
    const context = yield* Effect.context<
      FileSystem.FileSystem | Crypto.Crypto | HttpClient.HttpClient
    >();
    return CursorAccountReader.of({
      // Only a Keychain login asks the Keychain. The dashboard reader turns
      // its outcome, a failure included, into the source's message.
      read: (credentialSource, sinceMs, untilMs) =>
        readCursorAccountUsage(credentialSource, sinceMs, untilMs, keychain.accessToken).pipe(
          Effect.provideContext(context),
        ),
    });
  }),
);
