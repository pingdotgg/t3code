import * as HostProcess from "@t3tools/shared/HostProcess";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { DEFAULT_CURSOR_API_ENDPOINT } from "../apiKey.ts";
import type { CursorServerEndpoint } from "./connection.ts";

/** Cursor's background-composer RPCs, used by its own clients to manage cloud-agent VMs. */
const SERVICE = `${DEFAULT_CURSOR_API_ENDPOINT}/aiserver.v1.BackgroundComposerService`;

// cursor-server build the VM downloads when this host has no Cursor install to match.
const FALLBACK_CURSOR_SERVER_COMMIT = "b1aa50cb6db84fd3e8c808259cb172ea73425c10";

export type CursorCloudAgentStatus = "creating" | "running" | "finished" | "error" | "expired";

const AGENT_STATUS: Record<string, CursorCloudAgentStatus> = {
  BACKGROUND_COMPOSER_STATUS_CREATING: "creating",
  BACKGROUND_COMPOSER_STATUS_RUNNING: "running",
  BACKGROUND_COMPOSER_STATUS_FINISHED: "finished",
  BACKGROUND_COMPOSER_STATUS_ERROR: "error",
  BACKGROUND_COMPOSER_STATUS_EXPIRED: "expired",
};

const ProductJson = Schema.Struct({
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
});
const StatusResponse = Schema.Struct({ status: Schema.optional(Schema.String) });
const MachineResponse = Schema.Struct({ machine: Schema.optional(Schema.Unknown) });
const ServerUrlResponse = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Schema.Number,
  connectionToken: Schema.NonEmptyString,
  headers: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
  ),
  upgradePath: Schema.optional(Schema.String),
});

const rpc = Effect.fn("CursorCloudBackend.rpc")(function* <A, I>(
  accessToken: string,
  method: string,
  body: object,
  schema: Schema.Codec<A, I>,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(`${SERVICE}/${method}`).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeaders({ "connect-protocol-version": "1" }),
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  );
  return yield* HttpClientResponse.schemaBodyJson(schema)(
    yield* HttpClientResponse.filterStatusOk(response),
  );
});

export const readCursorCloudAgentStatus = (accessToken: string, agentId: string) =>
  rpc(accessToken, "GetBackgroundComposerStatus", { bcId: agentId }, StatusResponse).pipe(
    Effect.map(({ status }) => (status === undefined ? undefined : AGENT_STATUS[status])),
    Effect.timeout("10 seconds"),
  );

/** Whether Cursor reports a live VM for the agent; asleep agents have none. */
export const readCursorCloudMachineAwake = (accessToken: string, agentId: string) =>
  rpc(accessToken, "GetMachine", { bcId: agentId }, MachineResponse).pipe(
    Effect.map(({ machine }) => machine !== undefined && machine !== null),
    Effect.timeout("10 seconds"),
  );

/** Resolves the VM's cursor-server endpoint, waking the VM first when it is asleep. */
export const resolveCursorCloudServer = (accessToken: string, agentId: string, commit: string) =>
  rpc(
    accessToken,
    "GetCursorServerUrl",
    { bcId: agentId, commit, connectionToken: uuidV4Unsafe() },
    ServerUrlResponse,
  ).pipe(
    Effect.map(({ headers, upgradePath, ...endpoint }): CursorServerEndpoint => ({
      ...endpoint,
      ...(headers === undefined ? {} : { headers }),
      ...(upgradePath === undefined ? {} : { upgradePath }),
    })),
    Effect.timeout("2 minutes"),
  );

/** The installed Cursor's build, so the VM reuses the cursor-server Cursor itself would start. */
export const readCursorServerCommit = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const candidates =
    platform === "darwin"
      ? ["/Applications/Cursor.app/Contents/Resources/app/product.json"]
      : platform === "win32"
        ? [
            path.join(
              env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
              "Programs",
              "cursor",
              "resources",
              "app",
              "product.json",
            ),
          ]
        : [
            "/usr/share/cursor/resources/app/product.json",
            "/opt/Cursor/resources/app/product.json",
          ];
  for (const candidate of candidates) {
    const commit = yield* fileSystem.readFileString(candidate).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ProductJson))),
      Effect.map((product) => product.commit),
      Effect.orElseSucceed(() => undefined),
    );
    if (commit !== undefined) return commit;
  }
  return FALLBACK_CURSOR_SERVER_COMMIT;
});
