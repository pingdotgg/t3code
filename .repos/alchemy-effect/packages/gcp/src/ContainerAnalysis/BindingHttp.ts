import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { Note } from "./Note.ts";
import type { Occurrence } from "./Occurrence.ts";

/**
 * Shared HTTP scaffolding for Container Analysis get bindings.
 * NOT exported from index.ts.
 */
export const makeNoteHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (note: Note) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${note})`({
          iam: [grantFor(options.iam, note.name)],
        });
      }
      const name = yield* note.name;
      return Effect.fn(`${options.tag}(${note.LogicalId})`)(function* (request?: Omit<I, "name">) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeOccurrenceHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (occurrence: Occurrence) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${occurrence})`({
          iam: [grantFor(options.iam, occurrence.name)],
        });
      }
      const name = yield* occurrence.name;
      return Effect.fn(`${options.tag}(${occurrence.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
