import { assert, it } from "@effect/vitest"
import { FindMyWay as Router } from "effect/unstable/http"

it("path params match", () => {
  const router = Router.make<1 | 2 | "c" | "param">()

  router.on("GET", "/ab1", 1)
  router.on("GET", "/ab2", 2)
  router.on("GET", "/ac", "c")
  router.on("GET", "/:pam", "param")

  assert.strictEqual(router.find("GET", "/ab1")?.handler, 1)
  assert.strictEqual(router.find("GET", "/ab1/")?.handler, 1)
  assert.strictEqual(router.find("GET", "//ab1")?.handler, 1)
  assert.strictEqual(router.find("GET", "//ab1//")?.handler, 1)
  assert.strictEqual(router.find("GET", "/ab2")?.handler, 2)
  assert.strictEqual(router.find("GET", "/ab2/")?.handler, 2)
  assert.strictEqual(router.find("GET", "//ab2")?.handler, 2)
  assert.strictEqual(router.find("GET", "//ab2//")?.handler, 2)
  assert.strictEqual(router.find("GET", "/ac")?.handler, "c")
  assert.strictEqual(router.find("GET", "/ac/")?.handler, "c")
  assert.strictEqual(router.find("GET", "//ac")?.handler, "c")
  assert.strictEqual(router.find("GET", "//ac//")?.handler, "c")
  assert.strictEqual(router.find("GET", "/foo")?.handler, "param")
  assert.strictEqual(router.find("GET", "/foo/")?.handler, "param")
  assert.strictEqual(router.find("GET", "//foo")?.handler, "param")
  assert.strictEqual(router.find("GET", "//foo//")?.handler, "param")
  assert.deepStrictEqual(router.find("GET", "/abcdef"), {
    handler: "param",
    params: { pam: "abcdef" },
    searchParams: {}
  })
  assert.deepStrictEqual(router.find("GET", "/abcdef/"), {
    handler: "param",
    params: { pam: "abcdef" },
    searchParams: {}
  })
  assert.deepStrictEqual(router.find("GET", "//abcdef"), {
    handler: "param",
    params: { pam: "abcdef" },
    searchParams: {}
  })
})

it("does not read inherited static child entries", () => {
  const label = "\uE000"
  // oxlint-disable-next-line no-extend-native -- Reproduce an inherited entry without reaching into router internals.
  Object.defineProperty(Object.prototype, label, {
    configurable: true,
    value: {}
  })

  try {
    const router = Router.make<boolean>()
    router.on("GET", `/${label}`, true)

    assert.strictEqual(router.find("GET", `/${label}`)?.handler, true)
  } finally {
    Reflect.deleteProperty(Object.prototype, label)
  }
})
