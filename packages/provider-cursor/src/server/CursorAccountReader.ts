import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

import type { CursorCredentialSource } from "./accountCache.ts";
import { makeCursorAccountUsageReader, type CursorAccountUsageReadResult } from "./accountUsage.ts";

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
    const context = yield* Effect.context<Digest.Digest | HttpClient.HttpClient>();
    const read = yield* makeCursorAccountUsageReader;
    return CursorAccountReader.of({
      read: Effect.fn("CursorAccountReader.read")(function (credentialSource, sinceMs, untilMs) {
        return read(credentialSource, sinceMs, untilMs).pipe(Effect.provideContext(context));
      }),
    });
  }),
);
