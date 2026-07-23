import { assert, describe, it } from "@effect/vitest"
import { assertNone, assertSome, deepStrictEqual } from "@effect/vitest/utils"
import { Schema } from "effect"
import * as Option from "effect/Option"
import { TestSchema } from "effect/testing"
import { Cookies } from "effect/unstable/http"
import { assertSuccess } from "../../utils/assert.ts"

describe("Cookies", () => {
  it("expireCookie returns a Result with an expired Set-Cookie value", () => {
    assertSuccess(
      Cookies.expireCookie(Cookies.empty, "session", { path: "/", secure: true }),
      Cookies.fromReadonlyRecord({
        session: Cookies.makeCookieUnsafe("session", "", {
          path: "/",
          secure: true,
          maxAge: 0,
          expires: new Date(0)
        })
      })
    )
  })

  it("expireCookieUnsafe adds an expired Set-Cookie value", () => {
    deepStrictEqual(
      Cookies.expireCookieUnsafe(Cookies.empty, "session", { path: "/", secure: true }),
      Cookies.fromReadonlyRecord({
        session: Cookies.makeCookieUnsafe("session", "", {
          path: "/",
          secure: true,
          maxAge: 0,
          expires: new Date(0)
        })
      })
    )
  })

  describe("CookiesSchema", () => {
    it("serializerIso annotation", () => {
      const _sessionId = Schema.toIso(Cookies.CookiesSchema).at("sessionId")
      const cookies = Cookies.fromSetCookie([
        "sessionId=abc123; Path=/; HttpOnly; Secure",
        "theme=dark; Path=/; Max-Age=3600",
        "language=en; Domain=.example.com; SameSite=Lax"
      ])
      assertSuccess(
        _sessionId.getResult(cookies),
        Cookies.makeCookieUnsafe("sessionId", "abc123", { path: "/", httpOnly: true, secure: true })
      )
    })

    it("toCodecJson", async () => {
      const schema = Cookies.CookiesSchema
      const asserts = new TestSchema.Asserts(Schema.toCodecJson(Schema.toType(schema)))

      const encoding = asserts.encoding()

      await encoding.succeed(
        Cookies.fromSetCookie([
          "sessionId=abc123; Path=/; HttpOnly; Secure",
          "theme=dark; Path=/; Max-Age=3600",
          "language=en; Domain=.example.com; SameSite=Lax"
        ]),
        [
          "sessionId=abc123; Path=/; HttpOnly; Secure",
          "theme=dark; Max-Age=3600; Path=/",
          "language=en; Domain=example.com; SameSite=Lax"
        ]
      )
    })
  })

  it("get and getValue return Option", () => {
    const cookies = Cookies.fromSetCookie("session=abc; Path=/")
    assert.isTrue(Option.isSome(Cookies.get(cookies, "session")))
    assertSome(Cookies.getValue(cookies, "session"), "abc")
    assertNone(Cookies.get(cookies, "missing"))
    assertNone(Cookies.getValue(cookies, "missing"))
  })
})
