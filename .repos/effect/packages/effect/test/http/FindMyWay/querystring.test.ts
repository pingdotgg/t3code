import { assert, it } from "@effect/vitest"
import { FindMyWay as Router } from "effect/http"

it("should sanitize the url - query", () => {
  const router = Router.make<boolean>()
  router.on("GET", "/test", true)
  assert.deepStrictEqual(
    router.find("GET", "/test?hello=world")?.searchParams,
    { hello: "world" }
  )
})

it("should sanitize the url - hash", () => {
  const router = Router.make<boolean>()

  router.on("GET", "/test", true)

  assert.deepStrictEqual(router.find("GET", "/test#hello")?.searchParams, {
    hello: ""
  })
})

it("handles path and query separated by ;", () => {
  const router = Router.make<boolean>()
  router.on("GET", "/test", true)
  assert.deepStrictEqual(
    router.find("GET", "/test;jsessionid=123456")?.searchParams,
    { jsessionid: "123456" }
  )
})

it("handles %", () => {
  const router = Router.make<boolean>()
  router.on("GET", "/test", true)
  assert.deepStrictEqual(router.find("GET", "/test?%")?.searchParams, {
    "%": ""
  })
})

it("normalizes duplicate path slashes without changing query slashes", () => {
  const router = Router.make<boolean>()
  router.on("GET", "/user/:id", true)
  const result = router.find("GET", "//user//1?u=https://x.com/y")
  assert.deepStrictEqual(result?.params, { id: "1" })
  assert.deepStrictEqual(result?.searchParams, { u: "https://x.com/y" })
})

it("decodes percent-heavy parameters exactly once without changing query boundaries", () => {
  const router = Router.make<boolean>({ maxParamLength: 200_000 })
  router.on("GET", "/test/:id", true)
  const encoded = "%25".repeat(50_000) + "%252F%2f%C3%A9%20%25"
  const decoded = "%".repeat(50_000) + "%2F/é %"
  for (const delimiter of ["?", "#", ";"]) {
    const result = router.find("GET", "/test/" + encoded + delimiter + "value=%2525")
    assert.strictEqual(result?.handler, true)
    assert.deepStrictEqual(result?.params, { id: decoded })
    assert.deepStrictEqual(result?.searchParams, { value: "%25" })
  }
  assert.deepStrictEqual(router.find("GET", "/test/" + encoded)?.params, { id: decoded })
  assert.strictEqual(router.find("GET", "/test/" + encoded + "%zz"), undefined)
})

it("keeps ; in the path when useSemicolonDelimiter is false", () => {
  const router = Router.make<string>({ useSemicolonDelimiter: false })
  router.on("GET", "/test", "static")
  router.on("GET", "/test/:id", "param")

  assert.isUndefined(router.find("GET", "/test;jsessionid=123456"))
  assert.deepStrictEqual(router.find("GET", "/test/a;v=1?x=1;y=2"), {
    handler: "param",
    params: { id: "a;v=1" },
    searchParams: { x: "1;y=2" }
  })
})

const findLiteral = (route: Router.PathInput, url: string) => {
  const router = Router.make<true>({ decodeStaticPath: false, maxParamLength: 8 })
  router.on("GET", route, true)
  return router.find("GET", url)
}

it("matches static segments literally when decodeStaticPath is false", () => {
  for (
    const [route, url] of [
      ["/internal/signing/submit", "/internal/%73igning/submit"],
      ["/internal/keys/:id", "/internal/%6Beys/abc"],
      ["/internal/:a/keys/:b", "/internal/x/%6Beys/y"],
      ["/files/*", "/%66iles/a"],
      ["/files/:name.png", "/%66iles/a.png"],
      ["/files/pre-:name.png", "/files/%70re-a.png"],
      ["/files/pre-:name", "/files/pre%2Dx"],
      ["/files/pre*", "/files/%70rex"],
      ["/caf%C3%A9", "/caf%25C3%25A9"],
      ["/café", "/caf%C3%A9"]
    ] as const
  ) {
    assert.isUndefined(findLiteral(route, url), url)
  }
  assert.isDefined(findLiteral("/internal/signing/submit", "/internal/signing/submit"))
  assert.isDefined(findLiteral("/caf%C3%A9", "/caf%C3%A9"))
  assert.isDefined(findLiteral("/caf%C3%A9", "/caf%c3%a9"))
})

it("decodes parameters once when decodeStaticPath is false", () => {
  assert.deepStrictEqual(findLiteral("/keys/:id", "/keys/a%2Fb%20caf%C3%A9")?.params, { id: "a/b café" })
  assert.deepStrictEqual(findLiteral("/keys/:id", "/keys/%252f")?.params, { id: "%2f" })
  assert.deepStrictEqual(findLiteral("/a/:a/b/:b", "/a/x%20y/b/c%2Fd")?.params, { a: "x y", b: "c/d" })
  assert.deepStrictEqual(findLiteral("/files/*", "/files/a%2Fb/c%20d")?.params, { "*": "a/b/c d" })
  assert.deepStrictEqual(findLiteral("/files/:name.png", "/files/a%2Epng")?.params, { name: "a" })
  assert.deepStrictEqual(findLiteral("/files/pre-:name.png", "/files/pre-a%2Epng")?.params, { name: "a" })
  assert.deepStrictEqual(findLiteral("/files/pre*", "/files/prex%2Fy")?.params, { "*": "x/y" })
  assert.deepStrictEqual(findLiteral("/n/:id(^\\d+$)", "/n/%31%32")?.params, { id: "12" })
  assert.isUndefined(findLiteral("/slugs/:slug([^.]+)", "/slugs/a%2Eb"))
})

it("applies maxParamLength to decoded parameters when decodeStaticPath is false", () => {
  assert.deepStrictEqual(findLiteral("/keys/:id", "/keys/%41%42%43%44%45%46%47%48")?.params, { id: "ABCDEFGH" })
  assert.isUndefined(findLiteral("/keys/:id", "/keys/%41%42%43%44%45%46%47%48%49"))
  assert.deepStrictEqual(findLiteral("/n/:id(^\\w+$)", "/n/%41%42%43%44%45%46%47%48")?.params, { id: "ABCDEFGH" })
  assert.isUndefined(findLiteral("/n/:id(^\\w+$)", "/n/%41%42%43%44%45%46%47%48%49"))
})

it("treats malformed escapes in parameters as a miss when decodeStaticPath is false", () => {
  for (
    const [route, url] of [
      ["/keys/:id", "/keys/%zz"],
      ["/keys/:id", "/keys/%C3"],
      ["/files/*", "/files/a/%zz"]
    ] as const
  ) {
    assert.isUndefined(findLiteral(route, url), url)
  }
  // A literal % before the parameter is route text, not part of the decoded value.
  assert.deepStrictEqual(findLiteral("/files/100%:id", "/files/100%a")?.params, { id: "a" })
  assert.isUndefined(findLiteral("/files/100%:id", "/files/100%%zz"))

  const router = Router.make<string>({ decodeStaticPath: false })
  router.on("GET", "/en/:page", "page")
  router.on("GET", "/:lang/100%", "percent")
  assert.deepStrictEqual(router.find("GET", "/en/100%")?.params, { lang: "en" })
})

it("applies each path option independently", () => {
  const literal = Router.make<true>({ decodeStaticPath: false })
  literal.on("GET", "/internal/signing", true)
  assert.isDefined(literal.find("GET", "/INTERNAL//signing/;v=1"))
  assert.isUndefined(literal.find("GET", "/internal/%73igning"))

  const semicolon = Router.make<true>({ useSemicolonDelimiter: false })
  semicolon.on("GET", "/internal/signing", true)
  assert.isDefined(semicolon.find("GET", "/INTERNAL//%73igning/"))
  assert.isUndefined(semicolon.find("GET", "/internal/signing;v=1"))

  const defaults = Router.make<true>({ decodeStaticPath: undefined, useSemicolonDelimiter: undefined })
  defaults.on("GET", "/internal/signing", true)
  assert.isDefined(defaults.find("GET", "/internal/%73igning;v=1"))
})

it("strictConfig only matches the registered path", () => {
  const router = Router.make<true>(Router.strictConfig)
  router.on("GET", "/internal/signing/submit", true)
  router.on("GET", "/caf%C3%A9", true)

  assert.isDefined(router.find("GET", "/internal/signing/submit?x=1"))
  assert.isDefined(router.find("GET", "/caf%C3%A9"))
  for (
    const url of [
      "/internal/SIGNING/submit",
      "/internal//signing/submit",
      "/internal/signing/submit/",
      "/internal/%73igning/submit",
      "/internal/signing/submit;v=1",
      "/caf%c3%a9"
    ]
  ) {
    assert.isUndefined(router.find("GET", url), url)
  }
})
