/**
 * Typed arrays in shared memory, for passing data to workers without copying.
 *
 * Use {@link make} to allocate shared arrays and {@link schema} for worker RPC
 * payloads. Unlike transferred buffers, shared buffers remain usable by the
 * sender and multiple workers.
 *
 * With RPC, provide `RpcClient.layerProtocolWorker` on the client and
 * `RpcServer.layerProtocolWorkerRunner` on the server, with platform worker layers.
 *
 * **Gotchas**
 *
 * - Shared memory works only between threads of one process, such as
 *   worker threads in Node, Bun and Deno, and web workers. A child process
 *   receives a copy, so the schema rejects it.
 * - In browsers, `SharedArrayBuffer` needs a cross-origin isolated page,
 *   served with `Cross-Origin-Opener-Policy: same-origin` and
 *   `Cross-Origin-Embedder-Policy: require-corp`. Check {@link isAvailable}.
 * - Threads that write to the same memory race. Let each worker write its own
 *   range, or use `Atomics`.
 * - A field declared as `Schema.Uint8Array` is encoded as base64 by worker
 *   codecs, so the worker gets a private copy and its writes are lost. Use
 *   {@link schema} for shared fields.
 *
 * **Example** (Workers that write into one shared array)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Rpc, RpcClient, RpcGroup } from "effect/rpc"
 * import { SharedMemory } from "effect/workers"
 *
 * // shared.ts
 * export const Fill = Rpc.make("Fill", {
 *   payload: {
 *     data: SharedMemory.schema(Int32Array),
 *     from: Schema.Number,
 *     to: Schema.Number
 *   }
 * })
 * export const Compute = RpcGroup.make(Fill)
 *
 * // worker.ts
 * export const ComputeLive = Compute.toLayer({
 *   Fill: ({ data, from, to }) =>
 *     Effect.sync(() => {
 *       for (let i = from; i < to; i++) data[i] = i * 2
 *     })
 * })
 *
 * // main.ts
 * export const fillOnWorkers = Effect.gen(function*() {
 *   const data = SharedMemory.make(Int32Array, 1_000_000)
 *   const client = yield* RpcClient.make(Compute)
 *   yield* Effect.forEach(
 *     [[0, 500_000], [500_000, 1_000_000]],
 *     ([from, to]) => client.Fill({ data, from, to }),
 *     { concurrency: "unbounded" }
 *   )
 *   return data
 * })
 * ```
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Data from "../Data.ts"
import { passthroughLink } from "../internal/schema/passthrough.ts"
import * as Schema from "../Schema.ts"

/**
 * The typed arrays that can live in shared memory.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

/**
 * The constructors of {@link TypedArray}s.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type TypedArrayConstructor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | BigInt64ArrayConstructor
  | BigUint64ArrayConstructor

interface SharedByName {
  readonly Int8Array: Int8Array<SharedArrayBuffer>
  readonly Uint8Array: Uint8Array<SharedArrayBuffer>
  readonly Uint8ClampedArray: Uint8ClampedArray<SharedArrayBuffer>
  readonly Int16Array: Int16Array<SharedArrayBuffer>
  readonly Uint16Array: Uint16Array<SharedArrayBuffer>
  readonly Int32Array: Int32Array<SharedArrayBuffer>
  readonly Uint32Array: Uint32Array<SharedArrayBuffer>
  readonly Float32Array: Float32Array<SharedArrayBuffer>
  readonly Float64Array: Float64Array<SharedArrayBuffer>
  readonly BigInt64Array: BigInt64Array<SharedArrayBuffer>
  readonly BigUint64Array: BigUint64Array<SharedArrayBuffer>
}

/**
 * The kind of typed array `A`, backed by a `SharedArrayBuffer`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Shared<A extends TypedArray> = SharedByName[A[typeof Symbol.toStringTag]]

/**
 * Thrown by {@link make} when shared memory is unavailable.
 *
 * @see {@link isAvailable} Check availability before allocating.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class SharedMemoryError extends Data.TaggedError("SharedMemoryError")<{
  readonly message: string
}> {}

/**
 * Returns whether shared memory is available in this environment.
 *
 * **Details**
 *
 * True in Node, Bun and Deno. In browsers, true only on a cross-origin
 * isolated page (`crossOriginIsolated`).
 *
 * @stability unstable
 * @category guards
 * @since 4.1.5
 */
export const isAvailable = (): boolean =>
  typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated !== false

/**
 * Returns whether the view's memory is a `SharedArrayBuffer`.
 *
 * @stability unstable
 * @category guards
 * @since 4.1.5
 */
export const isShared = (view: ArrayBufferView): boolean =>
  typeof SharedArrayBuffer === "function" && view.buffer instanceof SharedArrayBuffer

/**
 * Allocates a zero-filled typed array of `length` elements in shared memory.
 *
 * **Gotchas**
 *
 * Throws {@link SharedMemoryError} when shared memory is unavailable.
 *
 * **Example** (Copying existing values into shared memory)
 *
 * ```ts import.meta.vitest
 * import { SharedMemory } from "effect/workers"
 *
 * const values = Int32Array.of(1, 2, 3)
 * const shared = SharedMemory.make(Int32Array, values.length)
 * shared.set(values)
 * values[0] = 9
 * shared[0] // => 1
 * ```
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const make = <C extends TypedArrayConstructor>(
  constructor: C,
  length: number
): Shared<InstanceType<C>> => {
  if (!isAvailable()) {
    throw new SharedMemoryError({
      message: "SharedArrayBuffer is unavailable. In browsers it needs a cross-origin isolated page, served with " +
        "`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`."
    })
  }
  const Ctor = constructor as new(buffer: SharedArrayBuffer) => any
  return new Ctor(new SharedArrayBuffer(length * constructor.BYTES_PER_ELEMENT))
}

/**
 * Creates a worker-message schema for a typed array backed by shared memory.
 *
 * **Details**
 *
 * - Decoding and encoding accept only instances of `constructor` backed by
 *   a `SharedArrayBuffer`. Serialized copies fail validation.
 * - `Schema.toCodecJson` passes the array through unchanged for `postMessage`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const schema = <C extends TypedArrayConstructor>(
  constructor: C
): Schema.declare<Shared<InstanceType<C>>> =>
  Schema.declare((u): u is Shared<InstanceType<C>> => u instanceof constructor && isShared(u), {
    expected: `${constructor.name} in shared memory`,
    toCodecJson: () => passthroughLink
  })
