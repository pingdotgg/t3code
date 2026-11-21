/**
 * Converts between `effect/ai` values and the Agent User Interaction (AG-UI)
 * protocol.
 *
 * An AG-UI run starts from a `RunAgentInput` and answers with a stream of
 * events. This module turns the input's conversation into a `Prompt`, turns
 * the parts streamed by `LanguageModel.streamText` into AG-UI events, and
 * wraps an event stream in the run lifecycle that AG-UI clients expect. It
 * performs no I/O; `AgUiServer` serves runs over HTTP.
 *
 * **Example** (Streaming a model response as AG-UI events)
 *
 * ```ts
 * import { Stream } from "effect"
 * import { AgUi, LanguageModel } from "effect/ai"
 * import type { AgUiSchema } from "effect/ai"
 *
 * const run = (input: AgUiSchema.RunAgentInput) =>
 *   LanguageModel.streamText({ prompt: AgUi.toPrompt(input) }).pipe(
 *     AgUi.fromStreamParts,
 *     AgUi.withRunLifecycle(input)
 *   )
 * ```
 *
 * @stability experimental
 * @since 4.1.0
 */
import * as Cause from "../Cause.ts"
import * as Effect from "../Effect.ts"
import * as ErrorReporter from "../ErrorReporter.ts"
import * as Predicate from "../Predicate.ts"
import * as Stream from "../Stream.ts"
import type * as AgUiSchema from "./AgUiSchema.ts"
import { protocolVersion } from "./AgUiSchema.ts"
import { IdGenerator } from "./IdGenerator.ts"
import * as Prompt from "./Prompt.ts"
import type * as Response from "./Response.ts"

// =============================================================================
// Prompt
// =============================================================================

/**
 * Converts the conversation in an AG-UI run input into a `Prompt`.
 *
 * **Details**
 *
 * - User and assistant messages keep their text. Assistant tool calls become
 *   tool-call parts with their JSON arguments parsed.
 * - Each tool message becomes a tool message with one tool-result part, named
 *   after the latest preceding assistant tool call with its id, since
 *   providers may reuse call ids across turns. Content that is valid JSON is
 *   parsed. A message with an `error` becomes a failed result carrying the
 *   error text, and a message carrying the failure metadata that
 *   {@link fromStreamParts} emits becomes a failed result carrying its content.
 * - User image, audio, video, and document parts with inline data or a valid
 *   URL become file parts.
 * - Activity and reasoning messages, provider file handles, and tool messages
 *   that answer no preceding tool call are dropped.
 *
 * **Gotchas**
 *
 * The whole conversation comes from the client. By default `system` and
 * `developer` messages and the input's `context` are dropped, so a browser
 * cannot replace the server's instructions. Set `trustClientInstructions` to
 * keep them: `system` and `developer` messages then become system messages in
 * place, and `context` becomes a leading system message.
 *
 * @stability experimental
 * @category converting
 * @since 4.1.0
 */
export const toPrompt = (input: AgUiSchema.RunAgentInput, options?: {
  readonly trustClientInstructions?: boolean | undefined
}): Prompt.Prompt => {
  const trusted = options?.trustClientInstructions === true
  // Filled as messages are consumed, so each result is named after the latest
  // preceding call with its id
  const toolNames = new Map<string, string>()

  const messages: Array<Prompt.MessageEncoded> = []
  if (trusted && input.context.length > 0) {
    messages.push({
      role: "system",
      content: input.context.map((context) => `${context.description}:\n${context.value}`).join("\n\n")
    })
  }
  for (const message of input.messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        if (trusted) {
          messages.push({ role: "system", content: message.content })
        }
        break
      }
      case "user": {
        messages.push({
          role: "user",
          content: typeof message.content === "string" ? message.content : userParts(message.content)
        })
        break
      }
      case "assistant": {
        const content: Array<Prompt.AssistantMessagePartEncoded> = []
        if (message.content !== undefined && message.content.length > 0) {
          content.push({ type: "text", text: message.content })
        }
        for (const toolCall of message.toolCalls ?? []) {
          toolNames.set(toolCall.id, toolCall.function.name)
          content.push({
            type: "tool-call",
            id: toolCall.id,
            name: toolCall.function.name,
            params: parseJson(toolCall.function.arguments)
          })
        }
        if (content.length > 0) {
          messages.push({ role: "assistant", content })
        }
        break
      }
      case "tool": {
        const name = toolNames.get(message.toolCallId)
        if (name === undefined) break
        messages.push({
          role: "tool",
          content: [{
            type: "tool-result",
            id: message.toolCallId,
            name,
            isFailure: message.error !== undefined || hasFailureMarker(message.metadata),
            result: message.error !== undefined
              ? message.error
              : typeof message.content === "string"
              ? parseJson(message.content)
              : message.content
          }]
        })
        break
      }
    }
  }
  return Prompt.make(messages)
}

// The marker `fromStreamParts` puts on failed results, which AG-UI clients keep
// on the tool message they send back
const hasFailureMarker = (metadata: AgUiSchema.Metadata | undefined): boolean => {
  const marker = metadata?.["effect/ai"]
  return Predicate.hasProperty(marker, "isFailure") && marker.isFailure === true
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const userParts = (parts: ReadonlyArray<AgUiSchema.ContentPart>): Array<Prompt.UserMessagePartEncoded> => {
  const out: Array<Prompt.UserMessagePartEncoded> = []
  for (const part of parts) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text })
      continue
    }
    const source = part.source
    if (source.type === "data") {
      out.push({ type: "file", mediaType: source.mimeType, data: source.value })
    } else if (source.type === "url" && URL.canParse(source.value)) {
      out.push({ type: "file", mediaType: source.mimeType ?? defaultMediaType[part.type], data: new URL(source.value) })
    }
  }
  return out
}

const defaultMediaType = {
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
  document: "application/octet-stream"
} as const

// =============================================================================
// Events
// =============================================================================

/**
 * Converts the parts streamed by `LanguageModel.streamText` into AG-UI events.
 *
 * **Details**
 *
 * - Each model round becomes a step named `step-1`, `step-2`, and so on. The
 *   round's `finish` part closes the step.
 * - Text parts become `TEXT_MESSAGE_*` events from the `assistant` role, and
 *   reasoning parts become a reasoning span holding one reasoning message.
 * - Streamed tool parameters become `TOOL_CALL_START`, `TOOL_CALL_ARGS`, and
 *   `TOOL_CALL_END`. A tool call that arrives without streamed parameters
 *   becomes the same sequence with its parameters as one JSON fragment. Tool
 *   calls name the step's latest text message as their parent.
 * - Final tool results become `TOOL_CALL_RESULT` events with a fresh message
 *   id from `IdGenerator`. Failed results carry
 *   `{ "effect/ai": { isFailure: true } }` as metadata.
 * - An `error` part is logged and becomes a `RUN_ERROR` event with a generic
 *   message.
 * - Preliminary tool results, approval requests, files, sources, and response
 *   metadata are dropped.
 *
 * Failures of the input stream are kept. Use {@link withRunLifecycle} to open
 * and close the run and to report failures to the client.
 *
 * @see {@link withRunLifecycle} for wrapping the events in a run
 *
 * @stability experimental
 * @category converting
 * @since 4.1.0
 */
export const fromStreamParts = <E, R>(
  self: Stream.Stream<Response.AnyPart, E, R>
): Stream.Stream<AgUiSchema.Event, E, R | IdGenerator> =>
  Stream.unwrap(Effect.gen(function*() {
    const idGenerator = yield* IdGenerator
    let step = 0
    let inStep = false
    let parentMessageId: string | undefined
    const streamedToolCalls = new Set<string>()

    const toolCallStart = (id: string, name: string): AgUiSchema.ToolCallStartEvent =>
      parentMessageId === undefined
        ? { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name }
        : { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, parentMessageId }

    const toEvents = (part: Response.AnyPart): Effect.Effect<ReadonlyArray<AgUiSchema.Event>> => {
      switch (part.type) {
        case "text-start": {
          parentMessageId = part.id
          return Effect.succeed([{ type: "TEXT_MESSAGE_START", messageId: part.id, role: "assistant" }])
        }
        case "text-delta":
          return Effect.succeed([{ type: "TEXT_MESSAGE_CONTENT", messageId: part.id, delta: part.delta }])
        case "text-end":
          return Effect.succeed([{ type: "TEXT_MESSAGE_END", messageId: part.id }])
        case "reasoning-start":
          return Effect.succeed([
            { type: "REASONING_START", messageId: part.id },
            { type: "REASONING_MESSAGE_START", messageId: part.id, role: "reasoning" }
          ])
        case "reasoning-delta":
          return Effect.succeed([{ type: "REASONING_MESSAGE_CONTENT", messageId: part.id, delta: part.delta }])
        case "reasoning-end":
          return Effect.succeed([
            { type: "REASONING_MESSAGE_END", messageId: part.id },
            { type: "REASONING_END", messageId: part.id }
          ])
        case "tool-params-start": {
          streamedToolCalls.add(part.id)
          return Effect.succeed([toolCallStart(part.id, part.name)])
        }
        case "tool-params-delta":
          return Effect.succeed([{ type: "TOOL_CALL_ARGS", toolCallId: part.id, delta: part.delta }])
        case "tool-params-end":
          return Effect.succeed([{ type: "TOOL_CALL_END", toolCallId: part.id }])
        case "tool-call": {
          if (streamedToolCalls.has(part.id)) return noEvents
          return Effect.succeed([
            toolCallStart(part.id, part.name),
            { type: "TOOL_CALL_ARGS", toolCallId: part.id, delta: JSON.stringify(part.params ?? {}) },
            { type: "TOOL_CALL_END", toolCallId: part.id }
          ])
        }
        case "tool-result": {
          if (part.preliminary) return noEvents
          const content = typeof part.encodedResult === "string"
            ? part.encodedResult
            : JSON.stringify(part.encodedResult) ?? ""
          return Effect.map(idGenerator.generateId(), (messageId): ReadonlyArray<AgUiSchema.Event> => [
            part.isFailure
              ? {
                type: "TOOL_CALL_RESULT",
                messageId,
                toolCallId: part.id,
                content,
                metadata: { "effect/ai": { isFailure: true } }
              }
              : { type: "TOOL_CALL_RESULT", messageId, toolCallId: part.id, content }
          ])
        }
        case "finish": {
          inStep = false
          parentMessageId = undefined
          return Effect.succeed([{ type: "STEP_FINISHED", stepName: `step-${step}` }])
        }
        case "error":
          return Effect.as(Effect.logError(part.error), [{ type: "RUN_ERROR", message: modelErrorMessage }])
        default:
          return noEvents
      }
    }

    return Stream.mapEffect(self, (part) => {
      if (inStep) return toEvents(part)
      inStep = true
      const started: AgUiSchema.Event = { type: "STEP_STARTED", stepName: `step-${++step}` }
      return Effect.map(toEvents(part), (events) => [started, ...events])
    }).pipe(Stream.flattenIterable)
  }))

const noEvents = Effect.succeed<ReadonlyArray<AgUiSchema.Event>>([])

const modelErrorMessage = "The model reported an error."

// =============================================================================
// Run lifecycle
// =============================================================================

/**
 * Wraps a stream of AG-UI events in the lifecycle of one run.
 *
 * **When to use**
 *
 * Use with {@link fromStreamParts} or with any hand-written event stream, so
 * clients always see a well-formed run.
 *
 * **Details**
 *
 * - `RUN_STARTED` is emitted first, with the run's ids and the protocol
 *   version. `RUN_STARTED` events from the input stream are dropped.
 * - When the input stream ends, any text message, tool call, reasoning span,
 *   step, or subagent it left open is closed, most recently opened first, and
 *   `RUN_FINISHED` is emitted. Closing events keep the `subagentRunId` of the
 *   event they close, steps are matched by name within each subagent, and a
 *   subagent left running ends with a `SUBAGENT_ERROR`.
 * - A `RUN_FINISHED` from the input stream ends the run, after closing
 *   anything left open, so a stream can report its own outcome. A `RUN_ERROR`
 *   from the input stream also ends the run.
 * - When the input stream fails, the cause is logged and reported, and the run
 *   ends with a `RUN_ERROR` whose message carries no error details.
 *   Interruptions are not converted.
 *
 * **Gotchas**
 *
 * To send a specific error to the client, emit a `RUN_ERROR` event from the
 * input stream instead of failing it.
 *
 * @see {@link fromStreamParts} for producing events from a model response
 *
 * @stability experimental
 * @category combinators
 * @since 4.1.0
 */
export const withRunLifecycle = (run: {
  readonly threadId: string
  readonly runId: string
}) =>
<E, R>(self: Stream.Stream<AgUiSchema.Event, E, R>): Stream.Stream<AgUiSchema.Event, never, R> =>
  Stream.suspend(() => {
    const threadId = run.threadId
    const runId = run.runId
    // Insertion order is opening order, so closing walks it backwards
    const open = new Map<string, AgUiSchema.Event>()
    let ended = false

    const closeOpen = (): Array<AgUiSchema.Event> => {
      const events = Array.from(open.values()).reverse()
      open.clear()
      return events
    }

    // Steps are named rather than identified, so they are keyed by owner too
    const stepKey = (event: AgUiSchema.StepStartedEvent | AgUiSchema.StepFinishedEvent) =>
      `step:${JSON.stringify([event.subagentRunId ?? null, event.stepName])}`

    const track = (event: AgUiSchema.Event): ReadonlyArray<AgUiSchema.Event> => {
      if (ended) return []
      switch (event.type) {
        case "RUN_STARTED":
          return []
        case "RUN_FINISHED": {
          ended = true
          return [...closeOpen(), event]
        }
        case "RUN_ERROR": {
          ended = true
          return [event]
        }
        case "TEXT_MESSAGE_START": {
          open.set(
            `text:${event.messageId}`,
            attributed({ type: "TEXT_MESSAGE_END", messageId: event.messageId }, event.subagentRunId)
          )
          break
        }
        case "TEXT_MESSAGE_END": {
          open.delete(`text:${event.messageId}`)
          break
        }
        case "TOOL_CALL_START": {
          open.set(
            `tool:${event.toolCallId}`,
            attributed({ type: "TOOL_CALL_END", toolCallId: event.toolCallId }, event.subagentRunId)
          )
          break
        }
        case "TOOL_CALL_END": {
          open.delete(`tool:${event.toolCallId}`)
          break
        }
        case "REASONING_START": {
          open.set(
            `reasoning:${event.messageId}`,
            attributed({ type: "REASONING_END", messageId: event.messageId }, event.subagentRunId)
          )
          break
        }
        case "REASONING_END": {
          open.delete(`reasoning:${event.messageId}`)
          break
        }
        case "REASONING_MESSAGE_START": {
          open.set(
            `reasoning-message:${event.messageId}`,
            attributed({ type: "REASONING_MESSAGE_END", messageId: event.messageId }, event.subagentRunId)
          )
          break
        }
        case "REASONING_MESSAGE_END": {
          open.delete(`reasoning-message:${event.messageId}`)
          break
        }
        case "STEP_STARTED": {
          open.set(stepKey(event), attributed({ type: "STEP_FINISHED", stepName: event.stepName }, event.subagentRunId))
          break
        }
        case "STEP_FINISHED": {
          open.delete(stepKey(event))
          break
        }
        case "SUBAGENT_STARTED": {
          open.set(`subagent:${event.subagentRunId}`, {
            type: "SUBAGENT_ERROR",
            subagentRunId: event.subagentRunId,
            message: subagentUnfinishedMessage
          })
          break
        }
        case "SUBAGENT_FINISHED":
        case "SUBAGENT_ERROR": {
          open.delete(`subagent:${event.subagentRunId}`)
          break
        }
      }
      return [event]
    }

    const started: AgUiSchema.Event = { type: "RUN_STARTED", threadId, runId, protocolVersion }
    const finished: AgUiSchema.Event = { type: "RUN_FINISHED", threadId, runId }

    return self.pipe(
      Stream.map(track),
      Stream.flattenIterable,
      Stream.takeUntil((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"),
      Stream.catchCause((cause) => {
        // An interrupt-only cause carries no failure of type E
        if (Cause.hasInterruptsOnly(cause)) return Stream.failCause(cause as Cause.Cause<never>)
        ended = true
        return Stream.fromEffect(
          Effect.logError(cause).pipe(
            Effect.andThen(ErrorReporter.report(cause)),
            Effect.as<AgUiSchema.Event>({ type: "RUN_ERROR", message: runErrorMessage })
          )
        )
      }),
      Stream.concat(Stream.suspend(() => ended ? Stream.empty : Stream.fromIterable([...closeOpen(), finished]))),
      Stream.prepend([started])
    )
  })

const runErrorMessage = "The agent run failed."

const subagentUnfinishedMessage = "The subagent did not finish."

const attributed = <A extends AgUiSchema.Event>(event: A, subagentRunId: string | undefined): A =>
  subagentRunId === undefined ? event : { ...event, subagentRunId }
