import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { DiscordREST } from "dfx/DiscordREST"
import * as Chat from "effect/chat/Chat"
import type { ChatAdapter } from "effect/chat/ChatAdapter"
import { Registry } from "effect/chat/ChatAdapter"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as fs from "node:fs"

/** The Janitor application the fixtures were recorded with. */
export const botUserId = "1564742987727118426"
export const tim = "449108784879763458"
export const guild = "840178841540362250"
export const scratch = "1570607253965246584"

export interface Dispatch {
  readonly receivedAt?: string
  readonly t: string
  readonly d: any
}

/** The dispatches of a gateway fixture in `fixtures/events`. */
export const events = (name: string): ReadonlyArray<Dispatch> =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/events/${name}.json`, import.meta.url), "utf8")).dispatches

interface RecordedCall {
  readonly step: string
  readonly method: string
  readonly path: string
  readonly request: any
  readonly status: number
  readonly response: any
}

/**
 * The slash commands recorded in EFF-3802, `fixtures/recorded/commands.json`.
 * The built command payloads start from these.
 */
export const recordedCommands: any = JSON.parse(
  fs.readFileSync(new URL("./fixtures/recorded/commands.json", import.meta.url), "utf8")
)

/** The REST calls of a fixture in `fixtures/recorded`. */
const recorded = (name: string): ReadonlyArray<RecordedCall> =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/recorded/${name}.json`, import.meta.url), "utf8")).calls

/** The one recorded call for `step`. */
export const step = (name: string, stepName: string): RecordedCall => {
  const found = recorded(name).filter((call) => call.step === stepName)
  if (found.length !== 1) throw new Error(`${name}/${stepName}: ${found.length} calls`)
  return found[0]
}

/** What dfx fails with for a 4xx answer, as the adapter reads it. */
export const errorResponse = (status: number, data: unknown) => ({
  _tag: status === 429 ? "RatelimitedResponse" : "ErrorResponse",
  data,
  response: { status },
  message: JSON.stringify(data)
})

/** What dfx fails with for a 5xx answer. */
export const statusCodeError = (status: number) => ({
  _tag: "HttpClientError",
  reason: { _tag: "StatusCodeError", response: { status } }
})

/** A recorded call as the fake's answer: its body, or dfx's error for it. */
export const answer = (call: RecordedCall): Effect.Effect<any, unknown> =>
  call.status >= 400 ? Effect.fail(errorResponse(call.status, call.response)) : Effect.succeed(call.response)

type Handler = (...args: Array<any>) => Effect.Effect<any, unknown>

export interface Fake {
  readonly calls: Array<{ readonly method: string; readonly args: ReadonlyArray<any> }>
  readonly called: (method: string) => ReadonlyArray<ReadonlyArray<any>>
  readonly service: DiscordREST["Service"]
}

/**
 * A `DiscordREST` that answers from `handlers` and records every call. A
 * method with no handler dies, so a test sees any call it didn't expect.
 * `withFiles` passes the request through and records the files it sent.
 */
export const makeFake = (handlers: Record<string, Handler>): Fake => {
  const calls: Array<{ method: string; args: ReadonlyArray<any> }> = []
  const service = new Proxy({}, {
    get: (_, method: string) => {
      if (method === "withFiles") {
        return (files: ReadonlyArray<File>) => (effect: Effect.Effect<any, any>) =>
          Effect.suspend(() => {
            calls.push({ method, args: [files] })
            return effect
          })
      }
      return (...args: Array<any>) =>
        Effect.suspend(() => {
          calls.push({ method, args })
          const handler = handlers[method]
          return handler === undefined ? Effect.die(new Error(`unexpected ${method}`)) : handler(...args)
        })
    }
  }) as DiscordREST["Service"]
  return {
    calls,
    called: (method) => calls.filter((call) => call.method === method).map((call) => call.args),
    service
  }
}

const getMyUser = () => Effect.succeed({ id: botUserId, username: "Janitor", bot: true })

const originalResponse = /\/webhooks\/([^/]+)\/([^/]+)\/messages\/@original$/

/**
 * The fake's `updateOriginalWebhookMessage` as Discord's HTTP answer, for
 * `followUp`, which sends over the plain `HttpClient`.
 */
const webhookEdit = (fake: Fake, request: HttpClientRequest.HttpClientRequest, path: RegExpExecArray) =>
  fake.service.updateOriginalWebhookMessage(decodeURIComponent(path[1]), decodeURIComponent(path[2]), {
    payload: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
  }).pipe(
    Effect.match({
      onSuccess: (body) => Response.json(body),
      onFailure: (error: any) => Response.json(error.data ?? {}, { status: error.response.status })
    }),
    Effect.map((response) => HttpClientResponse.fromWeb(request, response))
  )

/**
 * `DiscordChat.layer` over a fake, with `Chat` and an `HttpClient` that
 * answers an original response's edit from the fake, and any other request,
 * an attachment's download, from its `download` handler.
 */
export const discordLayer = (fake: Fake) =>
  DiscordChat.layer.pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(Layer.succeed(
      DiscordREST,
      new Proxy(fake.service, {
        get: (target, key) => key === "getMyUser" ? getMyUser : (target as any)[key]
      })
    )),
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const path = request.method === "PATCH" ? originalResponse.exec(request.url) : null
        return path !== null
          ? webhookEdit(fake, request, path)
          : (fake.service as any).download(request.url).pipe(
            Effect.map((bytes: Uint8Array<ArrayBuffer>) => HttpClientResponse.fromWeb(request, new Response(bytes)))
          )
      })
    ))
  )

export const adapter: Effect.Effect<ChatAdapter, unknown, Registry> = Effect.gen(function*() {
  const registry = yield* Registry
  return yield* registry.get("discord")
})
