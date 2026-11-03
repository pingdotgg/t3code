import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";

import * as Sqlite from "../Sqlite.ts";

export const layerReaderDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-routing-" });
    return Sqlite.layerFromPath(path.join(directory, "state.sqlite"));
  }),
).pipe(Layer.provide(NodeServices.layer));

export const traceSqlRouting = () => {
  const queries: Array<{ query: string; connection: unknown }> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") {
          let owner: Tracer.AnySpan | undefined = span;
          let connection: unknown;
          while (owner?._tag === "Span") {
            connection = owner.attributes.get("db.connection");
            if (connection !== undefined) break;
            owner = Option.getOrUndefined(owner.parent);
          }
          queries.push({ query, connection });
        }
      };
      return span;
    },
  });
  return {
    queries,
    trace: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.withTracer(tracer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      ),
  };
};
