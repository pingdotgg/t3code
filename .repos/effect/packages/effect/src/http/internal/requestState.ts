import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type { PreResponseHandler } from "../HttpEffect.ts"
import type { RedactedPath } from "./redactedPath.ts"

/**
 * Mutable state owned by the root that handles a single server request.
 *
 * @internal
 */
export class RequestState {
  preResponseHandler: PreResponseHandler | undefined = undefined
  loggerDisabled = false
  redactedUrlParamNames: ReadonlyArray<string | RegExp> = []
  redactedHeaderNames: ReadonlyArray<string | RegExp> = []
  redactedPath: RedactedPath | undefined = undefined
}

/**
 * Provided by request roots alongside `HttpServerRequest`. It has no default,
 * so writes outside a request do not reach shared state.
 *
 * @internal
 */
export const CurrentRequestState = Context.Service<RequestState>("effect/http/HttpEffect/CurrentRequestState")

/**
 * @internal
 */
export const appendPreResponseHandlerUnsafe = (context: Context.Context<never>, handler: PreResponseHandler): void => {
  const state = Context.getOrUndefined(context, CurrentRequestState)
  if (state === undefined) return
  const prev = state.preResponseHandler
  state.preResponseHandler = prev ?
    (request, response) => Effect.flatMap(prev(request, response), (response) => handler(request, response))
    : handler
}

/**
 * Adds names to redact in the server span of the current request. The span
 * is recorded after the handler restores its context, so scoped updates of
 * `CurrentRedactedNames` do not reach it.
 *
 * @internal
 */
export const addRedactedNamesUnsafe = (
  context: Context.Context<never>,
  urlParamNames: ReadonlyArray<string | RegExp>,
  headerNames: ReadonlyArray<string | RegExp>
): void => {
  const state = Context.getOrUndefined(context, CurrentRequestState)
  if (state === undefined) return
  if (urlParamNames.length > 0) state.redactedUrlParamNames = [...state.redactedUrlParamNames, ...urlParamNames]
  if (headerNames.length > 0) state.redactedHeaderNames = [...state.redactedHeaderNames, ...headerNames]
}
