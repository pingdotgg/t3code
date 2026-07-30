import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Redis } from "effect/unstable/persistence"

describe("Redis", () => {
  it("preserves __proto__ as an own script option", () => {
    const value = { polluted: true }
    const script = Redis.script(() => [], {
      ["__proto__"]: value,
      lua: "return nil",
      numberOfKeys: 0
    } as any)

    assert.isTrue(Object.hasOwn(script, "__proto__"))
    assert.strictEqual((script as any)["__proto__"], value)
  })

  it.effect("retries script loading when SCRIPT LOAD fails", () =>
    Effect.gen(function*() {
      const commands: Array<readonly [command: string, args: ReadonlyArray<string>]> = []
      let scriptLoadAttempts = 0
      const redis = yield* Redis.make({
        send: (command, ...args) =>
          Effect.suspend(() => {
            commands.push([command, args])
            if (command === "SCRIPT") {
              scriptLoadAttempts += 1
              if (scriptLoadAttempts === 1) {
                return Effect.fail(new Redis.RedisError({ cause: new Error("ERR transient script load failure") }))
              }
              return Effect.succeed("sha" as any)
            }
            return Effect.succeed("ok")
          })
      })
      const evalScript = redis.eval(
        Redis.script((key: string) => [key], {
          lua: "return KEYS[1]",
          numberOfKeys: 1
        }).withReturnType<string>()
      )

      const first = yield* Effect.result(evalScript("key"))
      const second = yield* evalScript("key")

      assert.strictEqual(first._tag, "Failure")
      assert.strictEqual(second, "ok")
      assert.deepStrictEqual(commands.map(([command]) => command), [
        "SCRIPT",
        "SCRIPT",
        "EVALSHA"
      ])
    }))

  it.effect("reloads and retries scripts when EVALSHA returns NOSCRIPT", () =>
    Effect.gen(function*() {
      const commands: Array<readonly [command: string, args: ReadonlyArray<string>]> = []
      let evalShaAttempts = 0
      const redis = yield* Redis.make({
        send: (command, ...args) =>
          Effect.suspend(() => {
            commands.push([command, args])
            if (command === "EVALSHA") {
              evalShaAttempts += 1
            }
            if (command === "SCRIPT") {
              return Effect.succeed("sha" as any)
            }
            if (command === "EVALSHA" && evalShaAttempts === 1) {
              return Effect.fail(new Redis.RedisError({ cause: new Error("NOSCRIPT No matching script") }))
            }
            return Effect.succeed("ok")
          })
      })
      const evalScript = redis.eval(
        Redis.script((key: string) => [key], {
          lua: "return KEYS[1]",
          numberOfKeys: 1
        }).withReturnType<string>()
      )

      const result = yield* evalScript("key")

      assert.strictEqual(result, "ok")
      assert.deepStrictEqual(commands.map(([command]) => command), [
        "SCRIPT",
        "EVALSHA",
        "SCRIPT",
        "EVALSHA"
      ])
    }))
})
