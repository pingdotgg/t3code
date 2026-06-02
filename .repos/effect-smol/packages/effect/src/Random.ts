/**
 * Pseudo-random generation through Effect's service context. The module exposes
 * effectful generators for booleans, doubles, safe integers, bounded numbers,
 * shuffling, and deterministic seeded runs.
 *
 * **Mental model**
 *
 * Randomness is read from the current {@link Random} service instead of a
 * global singleton. That makes random programs reproducible in tests and local
 * simulations with {@link withSeed}, while still allowing applications to
 * replace the service at the edge.
 *
 * **Common tasks**
 *
 * - Draw a floating-point value in `[0, 1)` with {@link next}
 * - Draw an integer with {@link nextInt} or {@link nextIntBetween}
 * - Draw a floating-point value in a custom range with {@link nextBetween}
 * - Randomize an iterable with {@link shuffle}
 * - Run the same random sequence repeatedly with {@link withSeed}
 *
 * **Gotchas**
 *
 * - The default service is not suitable for secrets, session identifiers,
 *   tokens, or other security-sensitive values.
 * - `withSeed` is deterministic by design. A predictable seed does not make
 *   generated values cryptographically secure.
 * - Bounded integer generation rounds bounds before drawing from the range.
 *
 * **Example** (Generating random values)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomFloat = yield* Random.next
 *   const randomInt = yield* Random.nextInt
 *   const diceRoll = yield* Random.nextIntBetween(1, 6)
 *
 *   return { randomFloat, randomInt, diceRoll }
 * })
 * ```
 *
 * @since 4.0.0
 */
import type * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import * as random from "./internal/random.ts"
import * as Predicate from "./Predicate.ts"

/**
 * Represents a service for generating pseudo-random numbers.
 *
 * **When to use**
 *
 * Use to access or provide the random-number generator service used by Effect
 * programs.
 *
 * **Gotchas**
 *
 * The default implementation is based on `Math.random` and is not
 * cryptographically secure. Replace the service with a cryptographically secure
 * implementation before using these generators for security-sensitive values.
 *
 * **Example** (Accessing the random service)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const float = yield* Random.next
 *   const integer = yield* Random.nextInt
 *   const inRange = yield* Random.nextIntBetween(1, 100)
 *
 *   console.log("Float:", float)
 *   console.log("Integer:", integer)
 *   console.log("In range:", inRange)
 * })
 * ```
 *
 * @category Random Number Generators
 * @since 2.0.0
 */
export const Random: Context.Reference<{
  nextIntUnsafe(): number
  nextDoubleUnsafe(): number
}> = random.Random

const randomWith = <A>(f: (random: typeof Random["Service"]) => A): Effect.Effect<A> =>
  Effect.withFiber((fiber) => Effect.succeed(f(fiber.getRef(Random))))

/**
 * Generates a random number between 0 (inclusive) and 1 (exclusive).
 *
 * **When to use**
 *
 * Use to generate a pseudo-random floating-point number in the standard
 * `[0, 1)` range.
 *
 * **Example** (Generating a random number)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomDouble = yield* Random.next
 *   console.log("Random double:", randomDouble)
 * })
 * ```
 *
 * @category Random Number Generators
 * @since 2.0.0
 */
export const next: Effect.Effect<number> = randomWith((r) => r.nextDoubleUnsafe())

/**
 * Generates a random boolean value.
 *
 * **When to use**
 *
 * Use to make a pseudo-random true-or-false choice.
 *
 * **Example** (Generating a random boolean)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const value = yield* Random.nextBoolean
 *   console.log("Random boolean:", value)
 * })
 * ```
 *
 * @category Random Number Generators
 * @since 2.0.0
 */
export const nextBoolean: Effect.Effect<boolean> = randomWith((r) => r.nextDoubleUnsafe() > 0.5)

/**
 * Generates a random integer between `Number.MIN_SAFE_INTEGER` (inclusive)
 * and `Number.MAX_SAFE_INTEGER` (inclusive).
 *
 * **When to use**
 *
 * Use to generate a pseudo-random safe integer across the full safe-integer
 * range.
 *
 * **Example** (Generating a random integer)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomInt = yield* Random.nextInt
 *   console.log("Random integer:", randomInt)
 * })
 * ```
 *
 * @category Random Number Generators
 * @since 2.0.0
 */
export const nextInt: Effect.Effect<number> = randomWith((r) => r.nextIntUnsafe())

/**
 * Generates a random number between `min` (inclusive) and `max` (exclusive).
 *
 * **When to use**
 *
 * Use to generate a pseudo-random floating-point number within a numeric range.
 *
 * **Example** (Generating a bounded random number)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomDouble = yield* Random.nextBetween(0, 1)
 *   console.log("Random double: ", randomDouble)
 * })
 * ```
 *
 * @category Random Number Generators
 * @since 4.0.0
 */
export const nextBetween = (min: number, max: number): Effect.Effect<number> =>
  randomWith((r) => r.nextDoubleUnsafe() * (max - min) + min)

/**
 * Generates a random integer between `min` and `max`.
 *
 * **When to use**
 *
 * Use to generate a pseudo-random integer within a rounded numeric range.
 *
 * **Details**
 *
 * The lower bound is rounded up with `Math.ceil` and the upper bound is
 * rounded down with `Math.floor`. By default the range is inclusive; set
 * `options.halfOpen: true` to exclude the upper bound.
 *
 * **Example** (Generating a bounded random integer)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const diceRoll1 = yield* Random.nextIntBetween(1, 6)
 *   const diceRoll2 = yield* Random.nextIntBetween(1, 6, {
 *     halfOpen: true
 *   })
 *   const diceRoll3 = yield* Random.nextIntBetween(0, 10)
 * })
 * ```
 *
 * @category Random Number Generators
 * @since 2.0.0
 */
export const nextIntBetween = (min: number, max: number, options?: {
  readonly halfOpen?: boolean
}): Effect.Effect<number> => {
  const extra = options?.halfOpen === true ? 0 : 1
  return randomWith((r) => {
    const minInt = Math.ceil(min)
    const maxInt = Math.floor(max)
    return Math.floor(r.nextDoubleUnsafe() * (maxInt - minInt + extra)) + minInt
  })
}

/**
 * Uses the pseudo-random number generator to shuffle the specified iterable.
 *
 * **When to use**
 *
 * Use to randomly reorder an iterable using the active `Random` service.
 *
 * **Example** (Shuffling values)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Random.shuffle([1, 2, 3, 4, 5])
 *   console.log(values)
 * })
 * ```
 *
 * @category Random Number Generators
 * @since 2.0.0
 */
export const shuffle = <A>(elements: Iterable<A>): Effect.Effect<Array<A>> =>
  randomWith((r) => {
    const buffer = Array.from(elements)
    for (let i = buffer.length - 1; i >= 1; i = i - 1) {
      const index = Math.min(i, Math.floor(r.nextDoubleUnsafe() * (i + 1)))
      const value = buffer[i]!
      buffer[i] = buffer[index]!
      buffer[index] = value
    }
    return buffer
  })

/**
 * Seeds the pseudo-random number generator with the specified value.
 *
 * **When to use**
 *
 * Use to run an effect with a deterministic pseudo-random sequence.
 *
 * **Details**
 *
 * Using the same seed produces the same random sequence, which is useful for
 * tests and reproducible simulations.
 *
 * **Gotchas**
 *
 * Use an unpredictable seed when uniqueness or unpredictability matters.
 *
 * **Example** (Seeding random generation)
 *
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const value1 = yield* Random.next
 *   const value2 = yield* Random.next
 *   console.log(value1, value2)
 * })
 *
 * // Same seed produces same sequence
 * const seeded1 = program.pipe(Random.withSeed("my-seed"))
 * const seeded2 = program.pipe(Random.withSeed("my-seed"))
 *
 * // Both will output identical values
 * Effect.runPromise(seeded1)
 * Effect.runPromise(seeded2)
 * ```
 *
 * @category Seeding
 * @since 4.0.0
 */
export const withSeed: {
  (seed: string | number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, seed: string | number): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: Effect.Effect<A, E, R>,
  seed: string | number
) => Effect.provideService(self, Random, ISAAC_CSPRNG(seed)))

/*///////////////////////////////////////////////////////////////////////////////////////////////////
This is a derivative work copyright (c) 2025 Effectful Technologies Inc, under MIT license.
This is a derivative work copyright (c) 2018, William P. "Mac" McMeans, under BSD license.
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of isaacCSPRNG nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
Original work copyright (c) 2012 Yves-Marie K. Rinquin, under MIT license.
https://github.com/rubycon/isaac.js
///////////////////////////////////////////////////////////////////////////////////////////////////*/
function ISAAC_CSPRNG(userSeed?: string | number) {
  // Internal State
  const memory = new Array(256)
  const result = new Array(256)
  let accumulator = 0
  let lastResult = 0
  let generation = 0
  let counter = 0

  // Initial Seed
  const internalSeed = Predicate.isUndefined(userSeed) ? getInitialSeed() : userSeed
  seed(internalSeed)

  function getInitialSeed() {
    const uint32a = new Uint32Array(2)
    crypto.getRandomValues(uint32a)
    return uint32a[0] + uint32a[1]
  }

  function reset() {
    accumulator = 0
    lastResult = 0
    counter = 0
    for (let i = 0; i < 256; ++i) {
      memory[i] = 0
      result[i] = 0
    }
    generation = 0
  }

  function seed(userSeed: string | number): void {
    // The golden ratio ( 2654435769 )
    // See https://stackoverflow.com/questions/4948780/magic-number-in-boosthash-combine
    const magicNumber = 0x9e3779b9
    let a = magicNumber
    let b = magicNumber
    let c = magicNumber
    let d = magicNumber
    let e = magicNumber
    let f = magicNumber
    let g = magicNumber
    let h = magicNumber
    let i = 0

    let seed: Array<number>
    if (Predicate.isString(userSeed)) {
      seed = toIntArray(userSeed)
    } else {
      seed = [userSeed]
    }

    reset()

    for (i = 0; i < seed.length; i++) {
      result[i & 0xff] += seed[i]
    }

    function mix() {
      a ^= b << 11
      d = add32(d, a)
      b = add32(b, c)

      b ^= c >>> 2
      e = add32(e, b)
      c = add32(c, d)

      c ^= d << 8
      f = add32(f, c)
      d = add32(d, e)

      d ^= e >>> 16
      g = add32(g, d)
      e = add32(e, f)

      e ^= f << 10
      h = add32(h, e)
      f = add32(f, g)

      f ^= g >>> 4
      a = add32(a, f)
      g = add32(g, h)

      g ^= h << 8
      b = add32(b, g)
      h = add32(h, a)

      h ^= a >>> 9
      c = add32(c, h)
      a = add32(a, b)
    }

    // Scramble the seed
    for (i = 0; i < 4; i++) {
      mix()
    }

    for (i = 0; i < 256; i += 8) {
      // Use all the information in the seed
      a = add32(a, result[i])
      b = add32(b, result[i + 1])
      c = add32(c, result[i + 2])
      d = add32(d, result[i + 3])
      e = add32(e, result[i + 4])
      f = add32(f, result[i + 5])
      g = add32(g, result[i + 6])
      h = add32(h, result[i + 7])

      mix()

      // Fill in the memory with messy stuff
      memory[i] = a
      memory[i + 1] = b
      memory[i + 2] = c
      memory[i + 3] = d
      memory[i + 4] = e
      memory[i + 5] = f
      memory[i + 6] = g
      memory[i + 7] = h
    }

    // Second pass to make sure seed affects memory
    for (i = 0; i < 256; i += 8) {
      a = add32(a, memory[i])
      b = add32(b, memory[i + 1])
      c = add32(c, memory[i + 2])
      d = add32(d, memory[i + 3])
      e = add32(e, memory[i + 4])
      f = add32(f, memory[i + 5])
      g = add32(g, memory[i + 6])
      h = add32(h, memory[i + 7])

      mix()

      // Fill in the memory with messy stuff (again)
      memory[i] = a
      memory[i + 1] = b
      memory[i + 2] = c
      memory[i + 3] = d
      memory[i + 4] = e
      memory[i + 5] = f
      memory[i + 6] = g
      memory[i + 7] = h
    }

    pnrg()

    generation = 256
  }

  function pnrg(n?: number): void {
    let i = 0
    let x = 0
    let y = 0

    n = Predicate.isUndefined(n) ? 1 : Math.abs(Math.floor(n))

    while (n--) {
      counter = add32(counter, 1)
      lastResult = add32(lastResult, counter)

      for (i = 0; i < 256; i++) {
        switch (i & 3) {
          case 0: {
            accumulator ^= accumulator << 13
            break
          }
          case 1: {
            accumulator ^= accumulator >>> 6
            break
          }
          case 2: {
            accumulator ^= accumulator << 2
            break
          }
          case 3: {
            accumulator ^= accumulator >>> 16
            break
          }
        }

        accumulator = add32(memory[(i + 128) & 0xff], accumulator)
        x = memory[i]

        memory[i] = add32(memory[(x >>> 2) & 0xff], add32(accumulator, lastResult))
        y = memory[i]

        result[i] = add32(memory[(y >>> 10) & 0xff], x)
        lastResult = result[i]
      }
    }
  }

  /**
   * Returns a signed, random integer in the range [-2^31, 2^31).
   */
  function nextInt32(): number {
    if (!generation--) {
      pnrg()
      generation = 255
    }
    return result[generation]
  }

  function nextIntUnsafe(): number {
    return Math.floor(nextDoubleUnsafe() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) +
      Number.MIN_SAFE_INTEGER
  }

  /**
   * Returns a 53-bit fraction in the range [0, 1).
   */
  function nextDoubleUnsafe(): number {
    const hi = (nextInt32() >>> 0) & 0x1FFFFF // take top 21 bits
    const lo = nextInt32() >>> 0 // full 32 bits

    // 53-bit integer
    const combined = hi * 4294967296 + lo

    return combined / 0x20000000000000 // [0, 1)
  }

  return { nextIntUnsafe, nextDoubleUnsafe }
}

/**
 * 32-bit addition with overflow handling (JavaScript numbers are 53-bit).
 *
 * Example: add32(0xFFFFFFFF, 0x00000001) = 0x00000000 (wraps around)
 */
function add32(x: number, y: number): number {
  // Add lower 16 bits separately to handle carry
  // Example: x=0x12345678, y=0xABCDEF01
  // lsb = (0x5678 + 0xEF01) = 0x14579
  const lsb = (x & 0xffff) + (y & 0xffff)

  // Add upper 16 bits + carry from lower addition
  // msb = (0x1234 + 0xABCD + (0x14579 >>> 16)) = (0x1234 + 0xABCD + 0x1) = 0xBE02
  const msb = (x >>> 16) + (y >>> 16) + (lsb >>> 16)

  // Combine: upper 16 bits | lower 16 bits (masked to prevent double carry)
  // return (0xBE02 << 16) | (0x14579 & 0xffff) = 0xBE024579
  return (msb << 16) | (lsb & 0xffff)
}

/**
 * Convert a UTF-16 strings to UTF-8 encoded 32-bit integers (little-endian).
 */
function toIntArray(seed: string): Array<number> {
  let c1 = 0 // First UTF-16 code unit
  let c2 = 0 // Second UTF-16 code unit (for surrogate pairs)
  let unicode = 0 // Combined unicode code point from surrogate pair
  const result: Array<number> = [] // Result array of 32-bit integers
  const buffer: Array<number> = [] // Temporary buffer for the UTF-8 bytes (max 4 bytes)
  const length = seed.length - 1

  let index = 0
  while (index < length) {
    c1 = seed.charCodeAt(index++)
    c2 = seed.charCodeAt(index + 1)

    // 0x0000 - 0x007f: ASCII, single byte UTF-8: 0xxxxxxxx
    // Example: 'A' (0x41) -> [0x41]
    if (c1 < 0x0080) {
      buffer.push(c1)
    } //
    // 0x0080 - 0x07ff: Two byte UTF-8: 110xxxxx 10xxxxxx
    // Example: '¢' (0xA2) -> [0xC2, 0xA2]
    else if (c1 < 0x0800) {
      // First byte: upper 5 bits + 110xxxxx marker
      // 0xA2 >>> 6 (0x02), & 0x1f = 0x02, | 0xc0 = 0xC2
      buffer.push(((c1 >>> 6) & 0x1f) | 0xc0)
      // Second byte: lower 6 bits + 10xxxxxxxx marker
      // 0xA2 & 0x3f = 0x22, | 0x80 = 0xA2
      buffer.push(((c1 >>> 0) & 0x3f) | 0x80)
    } //
    // 0x0800 - 0xffff (non-surrogate): Three byte UTF-8: 1110xxxx 10xxxxxx 10xxxxxx
    // Example: '€' (0x20AC) -> [0xE2, 0x82, 0xAC]
    else if ((c1 & 0xf800) != 0xd800) {
      // First byte: top 4 bits + 1110xxxx marker
      // 0x20AC >>> 12 = 0x02, & 0x0f = 0x02, | 0xe0 = 0xE2
      buffer.push(((c1 >>> 12) & 0x0f) | 0xe0)
      // Second byte: middle 6 bits + 10xxxxxx marker
      // 0x20AC >>> 6 = 0x82, & 0x3f = 0x02, | 0x80 = 0x82
      buffer.push(((c1 >>> 6) & 0x3f) | 0x80)
      // Third byte: lower 6 bits + 10xxxxxx marker
      // 0x20AC & 0x3f = 0x2C, | 0x80 = 0xAC
      buffer.push(((c1 >>> 0) & 0x3f) | 0x80)
    } //
    // 0xd800 - 0xdfff: Surrogate pairs, four byte UTF-8: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
    // Example: '𐍈' (U+10348, surrogates 0xD800 0xDF48) -> [0xF0, 0x90, 0x8D, 0x88]
    else if (((c1 & 0xfc00) == 0xd800) && ((c2 & 0xfc00) == 0xdc00)) {
      // Decode surrogate pair: combine 10 bits from each + 0x10000
      // ((0xDF48 & 0x3f) | ((0xD800 & 0x3f) << 10)) + 0x10000 = 0x10348
      unicode = ((c2 & 0x3f) | ((c1 & 0x3f) << 10)) + 0x10000
      // First byte: top 3 bits + 11110xxx marker
      // 0x10348 >>> 18 = 0x00, & 0x07 = 0x00, | 0xf0 = 0xF0
      buffer.push(((unicode >>> 18) & 0x07) | 0xf0)
      // Second byte: next 6 bits + 10xxxxxx marker
      // 0x10348 >>> 12 = 0x10, & 0x3f = 0x10, | 0x80 = 0x90
      buffer.push(((unicode >>> 12) & 0x3f) | 0x80)
      // Third byte: next 6 bits + 10xxxxxx marker
      // 0x10348 >>> 6 = 0x40D, & 0x3f = 0x0D, | 0x80 = 0x8D
      buffer.push(((unicode >>> 6) & 0x3f) | 0x80)
      // Fourth byte: lower 6 bits + 10xxxxxx marker
      // 0x10348 & 0x3f = 0x08, | 0x80 = 0x88
      buffer.push(((unicode >>> 0) & 0x3f) | 0x80)
      index++ // Skip second surrogate
    } else {
      // invalid char
    }

    // Pack 4 UTF-8 bytes -> 32-bit int (little-endian)
    // Example: [0xE2, 0x82, 0xAC, 0x00] -> 0x00ACE2E2
    if (buffer.length > 3) {
      result.push(
        (buffer.shift()! << 0) | // Byte 0 at bits 0-7:   0xE2 << 0  = 0x000000E2
          (buffer.shift()! << 8) | // Byte 1 at bits 8-15:  0x82 << 8  = 0x00008200
          (buffer.shift()! << 16) | // Byte 2 at bits 16-23: 0xAC << 16 = 0x00AC0000
          (buffer.shift()! << 24) // Byte 3 at bits 24-31: 0x00 << 24 = 0x00000000
      )
      // Result: 0x00AC82E2
    }
  }

  return result
}
