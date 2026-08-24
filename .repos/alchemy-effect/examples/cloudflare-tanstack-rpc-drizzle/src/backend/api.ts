import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Hyperdrive } from "./database.ts";
import { Todo, TodoNotFound, TodoRpcs } from "./rpc.ts";
import { relations, Todos } from "./schema.ts";

/**
 * The RPC backend. A {@link Cloudflare.Workers.RpcWorker} that serves {@link TodoRpcs}
 * over HTTP (JSON), backed by Drizzle talking to Neon Postgres through a
 * Hyperdrive pool. It is bound to the frontend as a private service binding —
 * the browser never reaches it directly; the TanStack `/rpc` route proxies to
 * it (see `src/routes/rpc.ts`).
 */
export default class Backend extends Cloudflare.Workers.RpcWorker<Backend>()(
  "Backend",
  {
    main: import.meta.filename,
    url: false, // disable workers.dev URL; we use the service binding instead
    schema: TodoRpcs,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.Postgres(conn.connectionString, { relations });

    // DB failures are unexpected here, so we `orDie` them into defects. That
    // keeps each handler's typed error channel aligned with its RPC schema
    // (`never` for list/create, `TodoNotFound` for toggle/delete).
    const handlers = TodoRpcs.toLayer({
      listTodos: () =>
        db
          .select()
          .from(Todos)
          .orderBy(Todos.id)
          .pipe(
            Effect.map((rows) => rows.map((row) => new Todo(row))),
            Effect.orDie,
          ),

      createTodo: ({ text }) =>
        db
          .insert(Todos)
          .values({ text })
          .returning()
          .pipe(
            Effect.map(([row]) => new Todo(row)),
            Effect.orDie,
          ),

      toggleTodo: ({ id, done }) =>
        db
          .update(Todos)
          .set({ done })
          .where(eq(Todos.id, id))
          .returning()
          .pipe(
            Effect.orDie, // this comes before flatMap so that database errors are converted to defects, while TodoNotFound remains a failure
            Effect.flatMap(([row]) =>
              row
                ? Effect.succeed(new Todo(row))
                : new TodoNotFound({ message: `Todo ${id} not found`, id }),
            ),
          ),

      deleteTodo: ({ id }) =>
        db
          .delete(Todos)
          .where(eq(Todos.id, id))
          .returning()
          .pipe(
            Effect.orDie,
            Effect.flatMap(([row]) =>
              row
                ? Effect.succeed(row.id)
                : new TodoNotFound({ message: `Todo ${id} not found`, id }),
            ),
          ),
    });

    return RpcServer.toHttpEffect(TodoRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
    );
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
