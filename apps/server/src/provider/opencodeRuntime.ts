import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as Sse from "effect/unstable/encoding/Sse";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { collectStreamAsString } from "./providerSnapshot.ts";

export type OpenCodeHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface OpenCodeProtocol {
  readonly promptShape: "flat" | "nested";
}

export interface OpenCodeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
  readonly durable?: {
    readonly aggregateID: string;
    readonly seq: number;
    readonly version: number;
  };
  readonly location?: {
    readonly directory: string;
    readonly workspaceID?: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OpenCodeRequestInput<S extends Schema.Top> {
  readonly operation: string;
  readonly schema: S;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface OpenCodeConnection {
  readonly url: string;
  readonly protocol: OpenCodeProtocol;
  readonly request: <S extends Schema.Top>(
    method: OpenCodeHttpMethod,
    path: string,
    input: OpenCodeRequestInput<S>,
  ) => Effect.Effect<S["Type"], OpenCodeRuntimeFailure, S["DecodingServices"]>;
  readonly globalEvents: Stream.Stream<OpenCodeEvent, OpenCodeRuntimeFailure>;
}

const OpenCodeRuntimeFailureReason = Schema.Literals([
  "command-exit",
  "connection-ended",
  "http-status",
  "transport",
]);

export class OpenCodeRuntimeError extends Schema.TaggedErrorClass<OpenCodeRuntimeError>()(
  "OpenCodeRuntimeError",
  {
    operation: Schema.String,
    reason: OpenCodeRuntimeFailureReason,
    status: Schema.optionalKey(Schema.Number),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "" : `, HTTP ${this.status}`;
    const exitCode = this.exitCode === undefined ? "" : `, exit ${this.exitCode}`;
    return `OpenCode 2 operation '${this.operation}' failed (${this.reason}${status}${exitCode}).`;
  }
}

export class OpenCodeUnsupportedPreviewError extends Schema.TaggedErrorClass<OpenCodeUnsupportedPreviewError>()(
  "OpenCodeUnsupportedPreviewError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `This OpenCode 2 preview is not supported during '${this.operation}'.`;
  }
}

export class OpenCodeCommandNotFoundError extends Schema.TaggedErrorClass<OpenCodeCommandNotFoundError>()(
  "OpenCodeCommandNotFoundError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode 2 command was not found during '${this.operation}'.`;
  }
}

export class OpenCodeTimeoutError extends Schema.TaggedErrorClass<OpenCodeTimeoutError>()(
  "OpenCodeTimeoutError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `OpenCode 2 operation '${this.operation}' timed out.`;
  }
}

export const isOpenCodeRuntimeError = Schema.is(OpenCodeRuntimeError);
export const isOpenCodeUnsupportedPreviewError = Schema.is(OpenCodeUnsupportedPreviewError);
export const isOpenCodeCommandNotFoundError = Schema.is(OpenCodeCommandNotFoundError);
export const isOpenCodeTimeoutError = Schema.is(OpenCodeTimeoutError);

export type OpenCodeRuntimeFailure =
  | OpenCodeRuntimeError
  | OpenCodeUnsupportedPreviewError
  | OpenCodeCommandNotFoundError
  | OpenCodeTimeoutError;

export class OpenCodeRuntime extends Context.Service<
  OpenCodeRuntime,
  {
    readonly attach: (input: {
      readonly binaryPath: string;
      readonly environment?: NodeJS.ProcessEnv;
    }) => Effect.Effect<OpenCodeConnection, OpenCodeRuntimeFailure>;
  }
>()("t3/provider/opencodeRuntime") {}

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

interface OpenCodeCommandInput {
  readonly operation: string;
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

const OpenCodeEventSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  data: Schema.Unknown,
  durable: Schema.optionalKey(
    Schema.Struct({
      aggregateID: Schema.String,
      seq: Schema.Number,
      version: Schema.Number,
    }),
  ),
  location: Schema.optionalKey(
    Schema.Struct({
      directory: Schema.String,
      workspaceID: Schema.optionalKey(Schema.String),
    }),
  ),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const OPENCODE_ATTACH_REQUEST_TIMEOUT = "10 seconds";

function environmentKey(environment: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function attachKey(input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): string {
  return `${input.binaryPath}\n${environmentKey(input.environment)}`;
}

function parseServiceUrl(stdout: string): string | null {
  for (const line of stdout.trim().split(/\r?\n/u).toReversed()) {
    const candidate = line.trim();
    if (!URL.canParse(candidate)) continue;
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  }
  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localRef(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let value = document;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isRecord(value)) return undefined;
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    value = value[segment];
  }
  return value;
}

function schemaPropertyNames(
  document: unknown,
  schema: unknown,
  visited = new Set<unknown>(),
): ReadonlySet<string> {
  if (!isRecord(schema) || visited.has(schema)) return new Set();
  visited.add(schema);

  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const nestedSchemas: Array<unknown> = [schema.allOf, schema.anyOf, schema.oneOf]
    .filter(Array.isArray)
    .flat();
  if (typeof schema.$ref === "string") nestedSchemas.push(localRef(document, schema.$ref));

  const result = new Set(properties);
  for (const nested of nestedSchemas) {
    for (const name of schemaPropertyNames(document, nested, visited)) result.add(name);
  }
  return result;
}

function findOperation(value: unknown, operationId: string, visited = new Set<unknown>()): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (visited.has(value)) return undefined;
  visited.add(value);

  if (isRecord(value) && value.operationId === operationId) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findOperation(nested, operationId, visited);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findPromptOperation(document: unknown): unknown {
  for (const operationId of ["v2.session.prompt", "session.prompt"]) {
    const operation = findOperation(document, operationId);
    if (operation !== undefined) return operation;
  }

  if (!isRecord(document)) return undefined;
  const paths = document.paths;
  if (!isRecord(paths)) return undefined;
  for (const [path, methods] of Object.entries(paths)) {
    if (!/^\/api\/session\/(?:\{[^}]+\}|:[^/]+)\/prompt$/u.test(path)) continue;
    if (isRecord(methods) && isRecord(methods.post)) return methods.post;
  }
  return undefined;
}

export function detectOpenCodeProtocol(document: unknown): OpenCodeProtocol | null {
  const operation = findPromptOperation(document);
  if (!isRecord(operation)) return null;
  const requestBody = operation.requestBody;
  const content = isRecord(requestBody) ? requestBody.content : undefined;
  const jsonContent = isRecord(content) ? content["application/json"] : undefined;
  const schema = isRecord(jsonContent) ? jsonContent.schema : undefined;
  const properties = schemaPropertyNames(document, schema);
  const promptShape = properties.has("text") ? "flat" : properties.has("prompt") ? "nested" : null;
  if (promptShape === null) return null;
  return { promptShape };
}

function requestUrl(
  baseUrl: string,
  path: string,
  query: OpenCodeRequestInput<Schema.Top>["query"],
): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function withAuthentication(
  request: HttpClientRequest.HttpClientRequest,
  password: string,
): HttpClientRequest.HttpClientRequest {
  return request.pipe(
    HttpClientRequest.basicAuth("opencode", password),
    HttpClientRequest.acceptJson,
  );
}

function makeRequest(
  method: OpenCodeHttpMethod,
  url: string,
  body: unknown | undefined,
): HttpClientRequest.HttpClientRequest {
  const request = HttpClientRequest.make(method)(url);
  return body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body));
}

function isCommandNotFoundCause(cause: unknown): boolean {
  return (
    cause instanceof PlatformError.PlatformError &&
    cause.reason instanceof PlatformError.SystemError &&
    cause.reason._tag === "NotFound"
  );
}

function makeConnection(input: {
  readonly baseUrl: string;
  readonly password: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly protocol: OpenCodeProtocol;
}): OpenCodeConnection {
  const request: OpenCodeConnection["request"] = (method, path, requestInput) =>
    Effect.gen(function* () {
      const response = yield* input.httpClient
        .execute(
          withAuthentication(
            makeRequest(
              method,
              requestUrl(input.baseUrl, path, requestInput.query),
              requestInput.body,
            ),
            input.password,
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: requestInput.operation,
                reason: "transport",
                cause,
              }),
          ),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* new OpenCodeRuntimeError({
          operation: requestInput.operation,
          reason: "http-status",
          status: response.status,
        });
      }
      const decodeEmptyResponse = Schema.decodeUnknownEffect(requestInput.schema);
      const decodeResponse =
        response.status === 204
          ? decodeEmptyResponse(undefined)
          : HttpClientResponse.schemaBodyJson(requestInput.schema)(response);
      return yield* decodeResponse.pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeUnsupportedPreviewError({
              operation: requestInput.operation,
              cause,
            }),
        ),
      );
    });

  const globalEvents = Stream.unwrap(
    input.httpClient
      .execute(
        withAuthentication(
          HttpClientRequest.get(requestUrl(input.baseUrl, "/api/event", undefined)).pipe(
            HttpClientRequest.setHeader("accept", "text/event-stream"),
          ),
          input.password,
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "event.subscribe",
              reason: "transport",
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.succeed(response.stream)
            : Effect.fail(
                new OpenCodeRuntimeError({
                  operation: "event.subscribe",
                  reason: "http-status",
                  status: response.status,
                }),
              ),
        ),
      ),
  ).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenCodeEventSchema)),
    Stream.map((event) => event.data),
    Stream.mapError((cause) =>
      isOpenCodeRuntimeError(cause) ||
      isOpenCodeUnsupportedPreviewError(cause) ||
      isOpenCodeCommandNotFoundError(cause) ||
      isOpenCodeTimeoutError(cause)
        ? cause
        : new OpenCodeUnsupportedPreviewError({
            operation: "event.subscribe",
            cause,
          }),
    ),
  );

  return {
    url: input.baseUrl,
    protocol: input.protocol,
    request,
    globalEvents,
  };
}

export const make = Effect.fn("OpenCodeRuntime.make")(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const connections = new Map<string, OpenCodeConnection>();
  const attachLock = yield* Semaphore.make(1);

  const runCommand = (command: OpenCodeCommandInput) =>
    Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(command.binaryPath, command.args, {
        env: command.environment,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, spawn.args, {
            env: command.environment,
            shell: spawn.shell,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isCommandNotFoundCause(cause)
              ? new OpenCodeCommandNotFoundError({
                  operation: command.operation,
                  cause,
                })
              : new OpenCodeRuntimeError({
                  operation: command.operation,
                  reason: "transport",
                  cause,
                }),
          ),
        );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout),
          collectStreamAsString(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntimeError({
              operation: command.operation,
              reason: "transport",
              cause,
            }),
        ),
      );
      return { stdout, stderr, code };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption("10 seconds"),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OpenCodeTimeoutError({
                operation: command.operation,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const attach: OpenCodeRuntime["Service"]["attach"] = (attachInput) => {
    const environment = attachInput.environment ?? process.env;
    const key = attachKey({ binaryPath: attachInput.binaryPath, environment });
    return attachLock.withPermit(
      Effect.gen(function* () {
        const existing = connections.get(key);
        if (existing) {
          const health = yield* Effect.exit(
            existing
              .request("GET", "/api/health", {
                operation: "health.get",
                schema: Schema.Unknown,
              })
              .pipe(
                Effect.timeoutOption(OPENCODE_ATTACH_REQUEST_TIMEOUT),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(new OpenCodeTimeoutError({ operation: "health.get" })),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
          );
          if (Exit.isSuccess(health)) return existing;
          connections.delete(key);
        }

        const start = yield* runCommand({
          operation: "service.start",
          binaryPath: attachInput.binaryPath,
          args: ["service", "start"],
          environment,
        });
        if (start.code !== 0) {
          return yield* new OpenCodeRuntimeError({
            operation: "service.start",
            reason: "command-exit",
            exitCode: start.code,
          });
        }
        const baseUrl = parseServiceUrl(start.stdout);
        if (baseUrl === null) {
          return yield* new OpenCodeUnsupportedPreviewError({
            operation: "service.start",
          });
        }

        const legacyPasswordResult = yield* runCommand({
          operation: "service.get.password",
          binaryPath: attachInput.binaryPath,
          args: ["service", "get", "password"],
          environment,
        });
        const passwordResult =
          legacyPasswordResult.code === 0
            ? legacyPasswordResult
            : yield* runCommand({
                operation: "service.password",
                binaryPath: attachInput.binaryPath,
                args: ["service", "password"],
                environment,
              });
        if (passwordResult.code !== 0) {
          return yield* new OpenCodeRuntimeError({
            operation: "service.password",
            reason: "command-exit",
            exitCode: passwordResult.code,
          });
        }
        const password = passwordResult.stdout.trim();
        if (password.length === 0) {
          return yield* new OpenCodeUnsupportedPreviewError({
            operation: "service.password",
          });
        }

        const provisional = makeConnection({
          baseUrl,
          password,
          httpClient,
          protocol: { promptShape: "flat" },
        });
        const document = yield* provisional
          .request("GET", "/openapi.json", {
            operation: "openapi.get",
            schema: Schema.Unknown,
          })
          .pipe(
            Effect.timeoutOption(OPENCODE_ATTACH_REQUEST_TIMEOUT),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OpenCodeTimeoutError({ operation: "openapi.get" })),
                onSome: Effect.succeed,
              }),
            ),
          );
        const protocol = detectOpenCodeProtocol(document);
        if (protocol === null) {
          return yield* new OpenCodeUnsupportedPreviewError({
            operation: "openapi.detect",
          });
        }

        const connection = makeConnection({
          baseUrl,
          password,
          httpClient,
          protocol,
        });
        connections.set(key, connection);
        return connection;
      }),
    );
  };

  return OpenCodeRuntime.of({ attach });
});

export const layer = Layer.effect(OpenCodeRuntime, make());
