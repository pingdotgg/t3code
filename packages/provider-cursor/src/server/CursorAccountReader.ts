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

export const layer = Layer.effect(
  CursorAccountReader,
  Effect.gen(function* () {
    const keychain = yield* CursorKeychain.CursorKeychain;
    const context = yield* Effect.context<
      FileSystem.FileSystem | Crypto.Crypto | HttpClient.HttpClient
    >();
    return CursorAccountReader.of({
      read: (credentialSource, sinceMs, untilMs) =>
        readCursorAccountUsage(credentialSource, sinceMs, untilMs, keychain.accessToken).pipe(
          Effect.provideContext(context),
        ),
    });
  }),
);
