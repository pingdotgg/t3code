import * as SqliteNode from "@effect/sql-sqlite-node"
import { Command, Flag } from "effect/unstable/cli"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { fileURLToPath } from "node:url"
import { ServerConfig } from "./config.ts"
import { runMigrations } from "./migrations.ts"
import { runServer } from "./server.ts"
import type { ServerConfigData } from "./config.ts"

const defaultAssetsDir = fileURLToPath(new URL("../../public", import.meta.url))
const defaultDbFilename = fileURLToPath(new URL("../../todo.sqlite", import.meta.url))

const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host interface to bind"),
  Flag.optional
)

const portFlag = Flag.integer("port").pipe(
  Flag.withDescription("Port to listen on"),
  Flag.optional
)

const assetsFlag = Flag.directory("assets").pipe(
  Flag.withDescription("Directory of static assets"),
  Flag.optional
)

const dbFlag = Flag.string("db").pipe(
  Flag.withDescription("SQLite database filename"),
  Flag.optional
)

const requestLoggingFlag = Flag.boolean("request-logging").pipe(
  Flag.withDescription("Enable request logging"),
  Flag.optional
)

const frontendDevOriginFlag = Flag.string("frontend-dev-origin").pipe(
  Flag.withDescription("Redirect frontend GET requests to a Vite dev server origin"),
  Flag.optional
)

const EnvServerConfig = Config.unwrap({
  host: Config.string("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.port("PORT").pipe(Config.withDefault(8787)),
  assetsDir: Config.string("ASSETS_DIR").pipe(Config.withDefault(defaultAssetsDir)),
  dbFilename: Config.string("DB_FILENAME").pipe(Config.withDefault(defaultDbFilename)),
  requestLogging: Config.boolean("REQUEST_LOGGING").pipe(Config.withDefault(true)),
  frontendDevOrigin: Config.string("FRONTEND_DEV_ORIGIN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined)
  )
})

export interface CliServerFlags {
  readonly host: Option.Option<string>
  readonly port: Option.Option<number>
  readonly assets: Option.Option<string>
  readonly db: Option.Option<string>
  readonly requestLogging: Option.Option<boolean>
  readonly frontendDevOrigin: Option.Option<string>
}

export const resolveServerConfig = (
  flags: CliServerFlags
): Effect.Effect<ServerConfigData, Config.ConfigError> =>
  Effect.gen(function*() {
    const env = yield* EnvServerConfig
    return {
      host: Option.getOrElse(flags.host, () => env.host),
      port: Option.getOrElse(flags.port, () => env.port),
      assetsDir: Option.getOrElse(flags.assets, () => env.assetsDir),
      dbFilename: Option.getOrElse(flags.db, () => env.dbFilename),
      requestLogging: Option.getOrElse(flags.requestLogging, () => env.requestLogging),
      frontendDevOrigin: Option.getOrElse(flags.frontendDevOrigin, () => env.frontendDevOrigin)
    }
  })


export const resetDatabase = (dbFilename: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    if (dbFilename !== ":memory:") {
      yield* fs.remove(path.resolve(dbFilename), { force: true })
    }

    const sqliteLayer = SqliteNode.SqliteClient.layer({
      filename: dbFilename
    })

    yield* runMigrations.pipe(Effect.provide(sqliteLayer))
  })

const commandFlags = {
  host: hostFlag,
  port: portFlag,
  assets: assetsFlag,
  db: dbFlag,
  requestLogging: requestLoggingFlag,
  frontendDevOrigin: frontendDevOriginFlag
} as const

const rootCommand = Command.make("effect-http-ws-cli", commandFlags).pipe(
  Command.withDescription("Run a unified Effect HTTP + WebSocket server"),
  Command.withHandler((flags) =>
    Effect.flatMap(resolveServerConfig(flags), (config) =>
      runServer.pipe(Effect.provideService(ServerConfig, config)))),
)

const resetCommand = Command.make("reset", commandFlags).pipe(
  Command.withDescription("Delete the SQLite database file and rerun migrations"),
  Command.withHandler((flags) =>
    Effect.flatMap(resolveServerConfig(flags), (config) => resetDatabase(config.dbFilename))
  )
)

export const cli = rootCommand.pipe(
  Command.withSubcommands([resetCommand])
)
