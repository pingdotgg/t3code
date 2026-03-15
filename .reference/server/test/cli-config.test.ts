import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { resolveServerConfig } from "../src/cli.ts"

describe("cli config resolution", () => {
  it.effect("falls back to effect/config values when flags are omitted", () =>
    Effect.gen(function*() {
      const resolved = yield* resolveServerConfig({
        host: Option.none(),
        port: Option.none(),
        assets: Option.none(),
        db: Option.none(),
        requestLogging: Option.none(),
        frontendDevOrigin: Option.none()
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              HOST: "0.0.0.0",
              PORT: "4001",
              ASSETS_DIR: "public",
              DB_FILENAME: "dev.sqlite",
              REQUEST_LOGGING: "false",
              FRONTEND_DEV_ORIGIN: "http://127.0.0.1:5173"
            }
          })
        )
      )

      expect(resolved).toEqual({
        host: "0.0.0.0",
        port: 4001,
        assetsDir: "public",
        dbFilename: "dev.sqlite",
        requestLogging: false,
        frontendDevOrigin: "http://127.0.0.1:5173"
      })
    })
  )

  it.effect("uses CLI flags when provided", () =>
    Effect.gen(function*() {
      const resolved = yield* resolveServerConfig({
        host: Option.some("127.0.0.1"),
        port: Option.some(8788),
        assets: Option.some("public"),
        db: Option.some("override.sqlite"),
        requestLogging: Option.some(true),
        frontendDevOrigin: Option.some("http://127.0.0.1:4173")
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              HOST: "0.0.0.0",
              PORT: "4001",
              ASSETS_DIR: "other",
              DB_FILENAME: "ignored.sqlite",
              REQUEST_LOGGING: "false",
              FRONTEND_DEV_ORIGIN: "http://127.0.0.1:5173"
            }
          })
        )
      )

      expect(resolved).toEqual({
        host: "127.0.0.1",
        port: 8788,
        assetsDir: "public",
        dbFilename: "override.sqlite",
        requestLogging: true,
        frontendDevOrigin: "http://127.0.0.1:4173"
      })
    })
  )
})
