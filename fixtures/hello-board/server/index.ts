import { definePlugin, type PluginRegistration } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const EchoToolInput = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(200)),
});

class HelloBoardPluginError extends Error {
  readonly _tag = "HelloBoardPluginError";
}

function toPluginError(error: unknown): HelloBoardPluginError {
  if (error instanceof Error) {
    return new HelloBoardPluginError(error.message, { cause: error });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new HelloBoardPluginError(error.message, { cause: error });
  }
  return new HelloBoardPluginError("hello-board plugin operation failed", { cause: error });
}

function noteBodyFromPayload(payload: unknown): Effect.Effect<string, Error> {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "body" in payload &&
    typeof payload.body === "string"
  ) {
    const body = payload.body.trim();
    if (body.length > 0 && body.length <= 500) {
      return Effect.succeed(body);
    }
  }

  return Effect.fail(
    new HelloBoardPluginError("body must be a non-empty string no longer than 500 characters"),
  );
}

export default definePlugin({
  register: (hostApi) =>
    Effect.gen(function* () {
      const database = yield* hostApi.database;
      const filesystem = yield* hostApi.filesystem;
      const httpClient = yield* hostApi.httpClient;

      const registration: PluginRegistration = {
        migrations: [
          {
            version: 1,
            name: "Create hello board notes",
            up: Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`
                CREATE TABLE p_hello_board_notes (
                  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                  body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 500),
                  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                )
              `;
            }).pipe(Effect.mapError(toPluginError)),
          },
        ],
        rpc: [
          {
            method: "listNotes",
            scope: "read" as const,
            handler: () =>
              database.execute(`
                SELECT id, body, created_at AS createdAt
                FROM p_hello_board_notes
                ORDER BY created_at DESC, id DESC
                LIMIT 50
              `),
          },
          {
            method: "addNote",
            scope: "operate" as const,
            handler: (payload: unknown) =>
              Effect.gen(function* () {
                const body = yield* noteBodyFromPayload(payload);
                const rows = yield* database.execute(
                  `
                    INSERT INTO p_hello_board_notes (body)
                    VALUES (?)
                    RETURNING id, body, created_at AS createdAt
                  `,
                  [body],
                );
                return rows[0] ?? { body };
              }),
          },
          {
            method: "exerciseCapabilities",
            scope: "operate" as const,
            handler: () =>
              Effect.gen(function* () {
                const roots = yield* filesystem.listRoots();
                const root = roots[0];
                if (!root) {
                  return yield* Effect.fail(
                    new HelloBoardPluginError("expected at least one filesystem root"),
                  );
                }
                yield* filesystem.writeFileString({
                  root,
                  relativePath: ".hello-board/capability.txt",
                  contents: "hello filesystem",
                });
                const file = yield* filesystem.readFileString({
                  root,
                  relativePath: ".hello-board/capability.txt",
                });
                const response = yield* httpClient.request({
                  method: "GET",
                  url: "https://fixture.test/ping",
                });
                return {
                  file,
                  status: response.status,
                  body: new TextDecoder().decode(response.body),
                };
              }),
          },
        ],
        tools: [
          {
            name: "echo_note",
            description: "Echo a short message back through the hello-board plugin tool path.",
            inputSchema: EchoToolInput,
            scope: "read",
            title: "Echo note",
            handle: (input, _ctx) =>
              Effect.succeed({
                content: [{ type: "text" as const, text: `hello-board: ${input.message}` }],
                structuredContent: { echoed: input.message, plugin: "hello-board" },
              }),
          },
        ],
      };
      return registration;
    }).pipe(Effect.mapError(toPluginError)),
});
