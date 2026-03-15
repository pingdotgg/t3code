import * as ServiceMap from "effect/ServiceMap"

export interface ServerConfigData {
  readonly host: string
  readonly port: number
  readonly assetsDir: string
  readonly dbFilename: string
  readonly requestLogging: boolean
  readonly frontendDevOrigin: string | undefined
}

export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigData>()(
  "effect-http-ws-cli/ServerConfig"
) {}
