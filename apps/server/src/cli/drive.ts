import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ClientOrchestrationCommand,
  CommandId,
  EnvironmentHttpApi,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";
import {
  DriveScenario,
  driveExampleCommand,
  driveScenarioCommand,
  driveServeCommand,
} from "./driveScenario.ts";

const connectionFlags = {
  baseDir: Flag.string("home-dir").pipe(Flag.withAlias("base-dir"), Flag.optional),
  url: Flag.string("url").pipe(
    Flag.withDescription("Running environment origin; authenticate with T3_DRIVE_TOKEN."),
    Flag.optional,
  ),
};

type ConnectionFlags = {
  readonly baseDir: Option.Option<string>;
  readonly url: Option.Option<string>;
};

class DriveConnectionError extends Schema.TaggedErrorClass<DriveConnectionError>()(
  "DriveConnectionError",
  { message: Schema.String },
) {}

const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientOrchestrationCommand));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeClient = (origin: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
type DriveClient = Effect.Success<ReturnType<typeof makeClient>>;

// Local commands borrow a short-lived session, just like `t3 project`.
// A failed live connection never falls back to opening the database offline.
const withConnection = Effect.fn("drive.withConnection")(function* <A, E, R>(
  flags: ConnectionFlags,
  operate: boolean,
  run: (client: DriveClient, headers: { authorization: string }) => Effect.Effect<A, E, R>,
) {
  const call = (origin: string, token: string) =>
    Effect.gen(function* () {
      const client = yield* makeClient(origin);
      return yield* run(client, { authorization: `Bearer ${token}` });
    }).pipe(Effect.timeout("30 seconds"), Effect.provide(FetchHttpClient.layer));

  if (Option.isSome(flags.url)) {
    const origin = flags.url.value;
    const parsed = yield* decodeUrl(origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      return yield* new DriveConnectionError({
        message: "--url must be an HTTP(S) origin without credentials, path, query, or fragment.",
      });
    }
    const token = yield* Config.redacted("T3_DRIVE_TOKEN");
    return yield* call(origin, Redacted.value(token));
  }

  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtime)) {
    return yield* new DriveConnectionError({
      message:
        "No running server found. Start t3 serve for this --home-dir, or pass --url and T3_DRIVE_TOKEN.",
    });
  }
  const origin = runtime.value.origin;
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      auth.issueSession({
        scopes: operate
          ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
          : [AuthOrchestrationReadScope],
        label: "t3 drive cli",
      }),
      (issued) => call(origin, issued.token),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(EnvironmentAuth.runtimeLayer.pipe(Layer.provide(ServerConfig.layer(config)))),
  );
});

const printJson = (value: unknown) => encodeJson(value).pipe(Effect.flatMap(Console.log));

const snapshotCommand = Command.make("snapshot", {
  ...connectionFlags,
  thread: Flag.string("thread").pipe(
    Flag.optional,
    Flag.withDescription("Thread id for full messages, activities, and state."),
  ),
}).pipe(
  Command.withDescription("Read the environment summary or one full thread as JSON."),
  Command.withHandler((flags) =>
    withConnection(flags, false, (client, headers) =>
      Effect.gen(function* () {
        const snapshot = Option.isSome(flags.thread)
          ? yield* client.orchestration.threadSnapshot({
              headers,
              params: { threadId: ThreadId.make(flags.thread.value) },
              payload: {},
            })
          : yield* client.orchestration.snapshot({ headers });
        yield* printJson(snapshot);
      }),
    ),
  ),
);

const dispatchCommand = Command.make("dispatch", {
  ...connectionFlags,
  file: Argument.string("file").pipe(
    Argument.withDescription("JSON client command. See t3 drive schema."),
  ),
}).pipe(
  Command.withDescription(
    "Dispatch one validated live command; print its durable sequence receipt.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = yield* decodeCommand(yield* fs.readFileString(flags.file));
      yield* withConnection(flags, true, (client, headers) =>
        client.orchestration
          .dispatch({ headers, payload: command } as Parameters<
            typeof client.orchestration.dispatch
          >[0])
          .pipe(Effect.flatMap(printJson)),
      );
    }),
  ),
);

const sendCommand = Command.make("send", {
  ...connectionFlags,
  thread: Argument.string("thread"),
  text: Argument.string("text"),
}).pipe(
  Command.withDescription(
    "Send a real user message using the thread's current model and permission modes.",
  ),
  Command.withHandler((flags) =>
    withConnection(flags, true, (client, headers) =>
      Effect.gen(function* () {
        const threadId = yield* decodeThreadId(flags.thread);
        const { thread } = yield* client.orchestration.threadSnapshot({
          headers,
          params: { threadId },
          payload: {},
        });
        const crypto = yield* Crypto.Crypto;
        const commandId = CommandId.make(yield* crypto.randomUUIDv4);
        const messageId = MessageId.make(yield* crypto.randomUUIDv4);
        const receipt = yield* client.orchestration.dispatch({
          headers,
          payload: {
            type: "thread.turn.start",
            commandId,
            threadId,
            message: { messageId, role: "user", text: flags.text, attachments: [] },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          },
        });
        yield* printJson({ commandId, messageId, ...receipt });
      }),
    ),
  ),
);

const schemaCommand = Command.make("schema", {
  scenario: Flag.boolean("scenario").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription(
    "Print JSON Schema for live commands, or --scenario for isolated scenarios.",
  ),
  Command.withHandler(({ scenario }) =>
    Effect.suspend(() => {
      const document = Schema.toJsonSchemaDocument(
        scenario ? DriveScenario : ClientOrchestrationCommand,
      );
      return printJson({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...document.schema,
        $defs: document.definitions,
      });
    }),
  ),
);

export const driveCommand = Command.make("drive").pipe(
  Command.withDescription(
    "Control running threads and build isolated, repeatable verification states. JSON output; no SQL.",
  ),
  Command.withSubcommands([
    snapshotCommand,
    dispatchCommand,
    sendCommand,
    schemaCommand,
    driveExampleCommand,
    driveScenarioCommand,
    driveServeCommand,
  ]),
  Command.provide(Layer.succeed(Logger.LogToStderr, true)),
);
