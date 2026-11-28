import * as Download from "@effect/chat-teams/internal/download"
import { assert, describe, it } from "@effect/vitest"
import type { ChatError } from "effect/chat/ChatError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"

interface Sent {
  readonly url: string
  readonly authorization: string | undefined
  readonly redirect: RequestRedirect | undefined
}

const serve = (handler: (url: string) => Response) => {
  const sent: Array<Sent> = []
  const http = HttpClient.make((request, url, _signal, fiber) =>
    Effect.sync(() => {
      sent.push({
        url: url.href,
        authorization: request.headers.authorization,
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect
      })
      return HttpClientResponse.fromWeb(request, handler(url.href))
    })
  )
  return { sent, http }
}

const connectorUrl = "https://smba.trafficmanager.net/amer/v3/attachments/0-cus-d1-abc/views/original"

const options = (http: HttpClient.HttpClient, maxBytes = 1024) => ({
  http,
  maxBytes,
  token: Effect.succeed(Redacted.make("secret")),
  connectorHosts: new Set(["smba.trafficmanager.net"]),
  fileHostSuffixes: ["sharepoint.com"],
  redirectHosts: new Set(["cdn.example.com"])
})

const reasonOf = <A>(stream: Stream.Stream<A, ChatError>) =>
  Stream.runDrain(stream).pipe(Effect.flip, Effect.map((error) => error.reason))

describe("download", () => {
  it.effect("sends the token to the Connector and streams the body", () =>
    Effect.gen(function*() {
      const { http, sent } = serve(() => new Response("hello"))
      const bytes = yield* Stream.mkUint8Array(Download.download(`connector:${connectorUrl}`, options(http)))
      assert.strictEqual(new TextDecoder().decode(bytes), "hello")
      assert.deepStrictEqual(sent, [{ url: connectorUrl, authorization: "Bearer secret", redirect: "manual" }])
    }))

  it.effect("sends the token on the first hop only, and never to an untrusted URL", () =>
    Effect.gen(function*() {
      const { http, sent } = serve((url) =>
        new Response(null, {
          status: 302,
          headers: { location: url === connectorUrl ? "https://cdn.example.com/file" : "https://evil.example/file" }
        })
      )
      const redirected = yield* reasonOf(Download.download(`connector:${connectorUrl}`, options(http)))
      assert.deepStrictEqual([redirected._tag, redirected.detail], ["Forbidden", "untrusted_url"])
      assert.deepStrictEqual(sent.map((request) => [request.url, request.authorization]), [
        [connectorUrl, "Bearer secret"],
        ["https://cdn.example.com/file", undefined]
      ])

      // A redirect host named as the first hop.
      const id = "connector:https://cdn.example.com/v3/attachments/a/views/original"
      const first = yield* reasonOf(Download.download(id, options(http)))
      assert.deepStrictEqual([first._tag, first.detail], ["Forbidden", "untrusted_url"])
      assert.strictEqual(sent.length, 2)
    }))

  it.effect("fails TooLarge past maxBytes", () =>
    Effect.gen(function*() {
      const { http } = serve(() => new Response(new Uint8Array(16)))
      const reason = yield* reasonOf(Download.download(`connector:${connectorUrl}`, options(http, 8)))
      assert.strictEqual(reason._tag, "TooLarge")
    }))
})

describe("classify", () => {
  it("refuses a lookalike file host", () => {
    const context = {
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationType: "personal",
      connectorHosts: new Set(["smba.trafficmanager.net"]),
      fileHostSuffixes: ["sharepoint.com"]
    }
    const attachment = (host: string) => ({
      contentType: Download.fileDownloadInfo,
      contentUrl: `https://${host}/personal/a/report.pdf`,
      name: "report.pdf",
      content: { downloadUrl: `https://${host}/download.aspx?tempauth=x` }
    })
    assert.deepStrictEqual(Download.classify(attachment("contoso.sharepoint.com"), context), {
      id: "preauth:https://contoso.sharepoint.com/download.aspx?tempauth=x",
      name: "report.pdf"
    })
    assert.deepStrictEqual(Download.classify(attachment("evilsharepoint.com"), context), {
      id: "url:https://evilsharepoint.com/personal/a/report.pdf",
      name: "report.pdf"
    })
  })
})
