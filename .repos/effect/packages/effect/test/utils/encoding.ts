import { afterAll, beforeAll, describe } from "@effect/vitest"

// The native `Uint8Array` Base64 and hex methods the encoding modules may use.
const natives = [
  [Uint8Array, "fromBase64"],
  [Uint8Array, "fromHex"],
  [Uint8Array.prototype, "toBase64"],
  [Uint8Array.prototype, "toHex"]
] as const

// Registers `suite` twice: once as is, and once with the native methods
// removed, so the fallbacks are covered on runtimes that ship them. The copies
// run sequentially, since the removal is global and the tests run concurrently.
export const describeWithFallback = (name: string, suite: () => void): void => {
  describe(name, { concurrent: false }, suite)
  describe(`${name} without native methods`, { concurrent: false }, () => {
    const descriptors = natives.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key))
    beforeAll(() => {
      for (const [target, key] of natives) Reflect.deleteProperty(target, key)
    })
    afterAll(() => {
      natives.forEach(([target, key], i) => {
        const descriptor = descriptors[i]
        if (descriptor !== undefined) Reflect.defineProperty(target, key, descriptor)
      })
    })
    suite()
  })
}
