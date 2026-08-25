import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Layer from "effect/Layer";
import { makeLexAliasHttpBinding } from "./BindingHttp.ts";
import { PutSession, type PutSessionRequest } from "./PutSession.ts";

/**
 * HTTP implementation of {@link PutSession} — calls the `lex-runtime-v2`
 * `PutSession` operation with the Lambda role's credentials and grants the
 * host `lex:PutSession` on the alias.
 */
export const PutSessionHttp = Layer.effect(
  PutSession,
  makeLexAliasHttpBinding<
    PutSessionRequest,
    lexr.PutSessionResponse,
    lexr.PutSessionError
  >({
    capability: "PutSession",
    iamActions: ["lex:PutSession"],
    operation: lexr.putSession,
  }),
);
