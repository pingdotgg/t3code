import { afterAll, beforeAll, describe } from "@effect/vitest"

// The native `Uint8Array` Base64 and hex methods the encoding modules may use.
const natives = [
  [Uint8Array, "fromBase64"],
  [Uint8Array, "fromHex"],
  [Uint8Array.prototype, "toBase64"],
  [Uint8Array.prototype, "toHex"]
] as const

// Registers `suite` with `properties` removed. It runs sequentially, since the
// removal is global and the tests run concurrently.
const describeWithout = (
  name: string,
  properties: ReadonlyArray<readonly [target: object, key: PropertyKey]>,
  suite: () => void
): void => {
  describe(name, { concurrent: false }, () => {
    const descriptors = properties.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key))
    beforeAll(() => {
      for (const [target, key] of properties) Reflect.deleteProperty(target, key)
    })
    afterAll(() => {
      properties.forEach(([target, key], i) => {
        const descriptor = descriptors[i]
        if (descriptor !== undefined) Reflect.defineProperty(target, key, descriptor)
      })
    })
    suite()
  })
}

// Registers `suite` with the native methods removed and `Buffer` left in
// place, so the `Buffer` fallback is covered on runtimes that ship them.
export const describeWithoutNatives = (name: string, suite: () => void): void => describeWithout(name, natives, suite)

// Registers `suite` twice: once as is, and once with the native methods and
// `Buffer` removed, so the JavaScript fallbacks are covered on every runtime.
export const describeWithFallback = (name: string, suite: () => void): void => {
  describe(name, { concurrent: false }, suite)
  describeWithout(`${name} without native methods`, [...natives, [globalThis, "Buffer"]], suite)
}
