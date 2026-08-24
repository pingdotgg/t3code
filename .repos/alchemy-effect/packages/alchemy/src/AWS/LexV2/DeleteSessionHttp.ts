import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Layer from "effect/Layer";
import { makeLexAliasHttpBinding } from "./BindingHttp.ts";
import { DeleteSession, type DeleteSessionRequest } from "./DeleteSession.ts";

/**
 * HTTP implementation of {@link DeleteSession} — calls the `lex-runtime-v2`
 * `DeleteSession` operation with the Lambda role's credentials and grants
 * the host `lex:DeleteSession` on the alias.
 */
export const DeleteSessionHttp = Layer.effect(
  DeleteSession,
  makeLexAliasHttpBinding<
    DeleteSessionRequest,
    lexr.DeleteSessionResponse,
    lexr.DeleteSessionError
  >({
    capability: "DeleteSession",
    iamActions: ["lex:DeleteSession"],
    operation: lexr.deleteSession,
  }),
);
