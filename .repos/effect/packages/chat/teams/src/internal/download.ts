import type { ChatError, ChatErrorReason } from "effect/chat/ChatError"
import type * as ChatMessage from "effect/chat/ChatMessage"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import * as Errors from "./errors.ts"
import { isObject, object, parseUrl, string } from "./parse.ts"

const op = "download"

/** The content type of a personal chat file the bot may fetch without credentials. @internal */
export const fileDownloadInfo = "application/vnd.microsoft.teams.file.download.info"

/**
 * An attachment id is one of:
 *
 * - `connector:{url}`: a Connector attachment view, fetched with the bot token.
 * - `preauth:{url}`: a pre-authenticated file URL, fetched with no credentials.
 *   The URL itself grants access, so it is never logged.
 * - `url:{url}`: any other URL. It is kept so the message shows the file,
 *   but `download` refuses it.
 *
 * @internal
 */
export type Kind = "connector" | "preauth" | "url"

const kinds: ReadonlyArray<Kind> = ["connector", "preauth", "url"]

/**
 * The path of a Connector attachment view:
 * `/{region}/v3/attachments/{id}/views/{view}`, where the region segment may be
 * absent. Each segment is letters, digits, `_` or `-`, and the URL has no
 * query.
 *
 * @internal
 */
export const connectorPath = /^(?:\/[A-Za-z0-9_-]+)?\/v3\/attachments\/[A-Za-z0-9_-]+\/views\/[A-Za-z0-9_-]+$/

/** Whether `host` is `suffix` or ends with `.{suffix}`. @internal */
export const underSuffix = (host: string, suffixes: ReadonlyArray<string>): boolean =>
  suffixes.some((raw) => {
    const suffix = raw.toLowerCase().replace(/^\./, "")
    return suffix.length > 0 && (host === suffix || host.endsWith(`.${suffix}`))
  })

const isIpLiteral = (host: string): boolean => host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)

/**
 * Parses `input` and checks the parts every hop needs: `https:`, no userinfo,
 * the default port and a host name rather than an IP literal. The fragment is
 * dropped, since it is never sent.
 *
 * @internal
 */
export const safeUrl = (input: string, base?: string): URL | undefined => {
  const url = parseUrl(input, base)
  if (
    url === undefined || url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.port !== "" || url.hostname.length === 0 || isIpLiteral(url.hostname)
  ) {
    return undefined
  }
  url.hash = ""
  return url
}

const size = (record: { readonly [key: string]: unknown }): number | undefined => {
  const value = record.size
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Turns a Bot Framework activity attachment into a chat attachment.
 *
 * - `connector:` when `contentUrl` has the origin of the activity's
 *   `serviceUrl`, its host is in `connectorHosts` and its path is
 *   {@link connectorPath}.
 * - `preauth:` for a file download info attachment in a personal chat whose
 *   `content.downloadUrl` is under one of `fileHostSuffixes`. Its
 *   `contentType` is Teams' own, so it is left out.
 * - `url:` for any other `https:` or `http:` `contentUrl`.
 *
 * An attachment with no usable URL, such as a card or the HTML copy of the
 * message, is `undefined`.
 *
 * @internal
 */
export const classify = (attachment: unknown, context: {
  readonly serviceUrl: string
  readonly conversationType?: string | undefined
  readonly connectorHosts: ReadonlySet<string>
  readonly fileHostSuffixes: ReadonlyArray<string>
}): ChatMessage.Attachment | undefined => {
  if (!isObject(attachment)) return undefined
  const contentType = string(attachment, "contentType")
  const name = string(attachment, "name")
  const content = object(attachment, "content")
  const make = (id: string, type: string | undefined, bytes: number | undefined): ChatMessage.Attachment => ({
    id,
    ...(name === undefined ? {} : { name }),
    ...(type === undefined ? {} : { contentType: type }),
    ...(bytes === undefined ? {} : { size: bytes })
  })

  if (contentType === fileDownloadInfo && context.conversationType === "personal" && content !== undefined) {
    const raw = string(content, "downloadUrl")
    const url = raw === undefined ? undefined : safeUrl(raw)
    if (url !== undefined && underSuffix(url.hostname, context.fileHostSuffixes)) {
      return make(`preauth:${url.href}`, undefined, size(content) ?? size(attachment))
    }
  }

  const raw = string(attachment, "contentUrl")
  if (raw === undefined) return undefined
  const type = contentType === fileDownloadInfo ? undefined : contentType
  const url = safeUrl(raw)
  const service = parseUrl(context.serviceUrl)
  if (
    url !== undefined && service !== undefined && url.origin === service.origin &&
    context.connectorHosts.has(url.hostname) && url.search === "" && connectorPath.test(url.pathname)
  ) {
    return make(`connector:${url.href}`, type, size(attachment))
  }
  const other = parseUrl(raw)
  if (other === undefined || (other.protocol !== "https:" && other.protocol !== "http:")) return undefined
  return make(`url:${other.href}`, type, size(attachment))
}

/**
 * Splits an attachment id into its kind and URL.
 *
 * @internal
 */
export const parseId = (id: string): { readonly kind: Kind; readonly url: string } | undefined => {
  const at = id.indexOf(":")
  if (at === -1) return undefined
  const kind = kinds.find((kind) => kind === id.slice(0, at))
  return kind === undefined ? undefined : { kind, url: id.slice(at + 1) }
}

/** @internal */
export interface DownloadOptions {
  readonly maxBytes: number
  /** The bot token. It is read only for a `connector:` id, and sent on its first request only. */
  readonly token: Effect.Effect<Redacted.Redacted<string>, ChatError>
  /** Exact Connector hosts. */
  readonly connectorHosts: ReadonlySet<string>
  /** Host suffixes for pre-authenticated file URLs, matched at a label boundary. */
  readonly fileHostSuffixes: ReadonlyArray<string>
  /** Exact hosts a redirect may also go to. Empty by default. */
  readonly redirectHosts?: ReadonlySet<string> | undefined
  readonly http?: HttpClient.HttpClient | undefined
}

/** The most redirects one download follows. @internal */
export const maxRedirects = 3

const redirects: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

const fail = (reason: ChatErrorReason) => Effect.fail(Errors.chatError(op, reason))

/**
 * Streams the file behind an attachment id.
 *
 * Every hop must pass {@link safeUrl}. The first must have a host in the id's
 * own allowlist (exact `connectorHosts` for `connector:`, `fileHostSuffixes`
 * for `preauth:`), and a redirect a host there or in `redirectHosts`. A
 * redirect host never receives the token. The first hop of a
 * `connector:` id must also have the {@link connectorPath} shape. A URL that
 * fails fails `Forbidden` with detail `untrusted_url`.
 *
 * Requests carry only the headers set here: the bearer token, on the first
 * hop of a `connector:` id. Redirects are read by hand, at most
 * {@link maxRedirects} of them, and only 301, 302, 303, 307 and 308, each sent
 * again as a GET. Fetch runs with `redirect: "manual"`, and a response from
 * another URL than the request's is refused, since a client followed a
 * redirect without the checks.
 *
 * Errors and spans hold the host only: a `preauth:` URL is a credential.
 * The client's own span is turned off for the same reason, as it records the
 * whole URL.
 *
 * @internal
 */
export function download(
  id: string,
  options: DownloadOptions & { readonly http: HttpClient.HttpClient }
): Stream.Stream<Uint8Array, ChatError>
export function download(
  id: string,
  options: DownloadOptions
): Stream.Stream<Uint8Array, ChatError, HttpClient.HttpClient>
export function download(
  id: string,
  options: DownloadOptions
): Stream.Stream<Uint8Array, ChatError, HttpClient.HttpClient> {
  return Stream.unwrap(Effect.gen(function*() {
    const parsed = parseId(id)
    if (parsed === undefined) return yield* fail(Errors.invalidRequest("attachment_id"))
    if (parsed.kind === "url") return yield* fail(Errors.unsupported("download", "url_attachment"))
    const { kind } = parsed
    const redirectHosts = options.redirectHosts ?? new Set<string>()
    // The id's own allowlist. `redirectHosts` never vouches for the first
    // hop, since the first hop of a `connector:` id is the one with the token.
    const own = (url: URL): boolean =>
      kind === "connector"
        ? options.connectorHosts.has(url.hostname)
        : underSuffix(url.hostname, options.fileHostSuffixes)
    const allowed = (url: URL): boolean => own(url) || redirectHosts.has(url.hostname)

    const first = safeUrl(parsed.url)
    if (
      first === undefined || !own(first) ||
      (kind === "connector" && (first.search !== "" || !connectorPath.test(first.pathname)))
    ) {
      return yield* fail(Errors.untrustedUrl())
    }

    const http = HttpClient.withScope(options.http ?? (yield* HttpClient.HttpClient))
    const tooLarge = Errors.chatError(op, Errors.tooLarge("files", "max_bytes"))

    const send = (url: URL, hop: number) =>
      Effect.gen(function*() {
        let request = HttpClientRequest.get(url.href)
        if (kind === "connector" && hop === 0) {
          const token = yield* Effect.mapError(options.token, Errors.withOp(op))
          request = HttpClientRequest.bearerToken(request, Redacted.value(token))
        }
        const sent = Option.getOrUndefined(HttpClientRequest.toUrl(request))?.href
        const response = yield* http.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError((error) => Errors.chatError(op, Errors.transport(false, error.reason._tag)))
        )
        yield* Effect.annotateCurrentSpan("http.response.status_code", response.status)
        if (response.url !== sent) return yield* fail(Errors.untrustedUrl())
        return response
      }).pipe(
        Effect.withSpan("TeamsChat.download.request", {
          kind: "client",
          attributes: { "server.address": url.hostname, "teams.download.hop": hop }
        })
      )

    let url = first
    let response: HttpClientResponse.HttpClientResponse
    for (let hop = 0;; hop++) {
      response = yield* send(url, hop)
      if (!redirects.has(response.status)) break
      if (hop === maxRedirects) return yield* fail(Errors.invalidResponse(false, "too_many_redirects"))
      const location = response.headers.location
      if (location === undefined) return yield* fail(Errors.invalidResponse(false, "missing_location"))
      const next = safeUrl(location, url.href)
      if (next === undefined || !allowed(next)) return yield* fail(Errors.untrustedUrl())
      url = next
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* fail(Errors.reasonForStatus(response.status, { write: false }))
    }
    const length = Number(response.headers["content-length"])
    if (Number.isFinite(length) && length > options.maxBytes) return yield* Effect.fail(tooLarge)
    let received = 0
    return response.stream.pipe(
      Stream.mapError((error) => Errors.chatError(op, Errors.transport(false, error.reason._tag))),
      Stream.mapEffect((chunk) => {
        received += chunk.length
        return received > options.maxBytes ? Effect.fail(tooLarge) : Effect.succeed(chunk)
      })
    )
  }))
}
