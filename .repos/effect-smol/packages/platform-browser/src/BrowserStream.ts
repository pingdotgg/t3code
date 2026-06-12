/**
 * Convert browser DOM events into Effect streams.
 *
 * This module provides typed constructors for listening to `window` and
 * `document` events from Effect programs. Use {@link fromEventListenerWindow}
 * for viewport, network, focus, pointer, keyboard, and other `Window` events,
 * and use {@link fromEventListenerDocument} for document lifecycle,
 * visibility, selection, fullscreen, and other `Document` events.
 *
 * ## Mental model
 *
 * Each constructor registers a DOM `addEventListener` callback when the stream
 * is consumed and removes it when the stream is finalized. Browser events are
 * push-based `EventTarget` notifications, so the browser does not slow down the
 * event source when downstream stream processing is busy. Events are buffered
 * inside the stream until a consumer pulls them.
 *
 * ## Common tasks
 *
 * - Track browser state such as resize, online / offline, focus, visibility, or
 *   pointer activity with Effect stream operators.
 * - Scope DOM listeners to a fiber so they are removed when the consuming
 *   effect is interrupted or completes.
 * - Set `bufferSize` for bursty event sources before applying sampling,
 *   throttling, debouncing, or dropping logic downstream.
 *
 * ## Gotchas
 *
 * The default buffer is unbounded. High-frequency sources such as `scroll`,
 * `pointermove`, or `mousemove` should usually specify `bufferSize` and reduce
 * the event rate with stream operators.
 *
 * These helpers are for DOM events, not for `ReadableStream` request or
 * response bodies. Fetch bodies follow Web Streams rules such as
 * single-consumer locking and disturbed bodies after reads. When using the DOM
 * `once` option, also use `Stream.take(1)` if the consuming code needs a finite
 * stream.
 *
 * @since 4.0.0
 */

import * as Stream from "effect/Stream"

/**
 * Creates a `Stream` from `window.addEventListener`.
 *
 * **Details**
 *
 * By default, the underlying buffer is unbounded in size. You can customize the
 * buffer size by passing an object as the second argument with the `bufferSize`
 * field.
 *
 * @category Streams
 * @since 4.0.0
 */
export const fromEventListenerWindow = <K extends keyof WindowEventMap>(
  type: K,
  options?: boolean | {
    readonly capture?: boolean
    readonly passive?: boolean
    readonly once?: boolean
    readonly bufferSize?: number | undefined
  } | undefined
): Stream.Stream<WindowEventMap[K], never, never> => Stream.fromEventListener<WindowEventMap[K]>(window, type, options)

/**
 * Creates a `Stream` from `document.addEventListener`.
 *
 * **Details**
 *
 * By default, the underlying buffer is unbounded in size. You can customize the
 * buffer size by passing an object as the second argument with the `bufferSize`
 * field.
 *
 * @category Streams
 * @since 4.0.0
 */
export const fromEventListenerDocument = <K extends keyof DocumentEventMap>(
  type: K,
  options?: boolean | {
    readonly capture?: boolean
    readonly passive?: boolean
    readonly once?: boolean
    readonly bufferSize?: number | undefined
  } | undefined
): Stream.Stream<DocumentEventMap[K], never, never> =>
  Stream.fromEventListener<DocumentEventMap[K]>(document, type, options)
