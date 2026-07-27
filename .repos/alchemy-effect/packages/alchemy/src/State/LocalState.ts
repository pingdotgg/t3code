import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { decodeFqn, encodeFqn } from "../FQN.ts";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import { State, StateStoreError, type StateService } from "./State.ts";
import { encodeState, reviveState } from "./StateEncoding.ts";

export const localState = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();

      const make = makeLocalState().pipe(
        recordStateStoreInit,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  );

export const makeLocalState = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotAlchemy = path.join(process.cwd(), ".alchemy");
    const stateDir = path.join(dotAlchemy, "state");

    const fail = (err: PlatformError) =>
      Effect.fail(
        new StateStoreError({
          message: err.message,
          cause: err,
        }),
      );

    const recover = <T>(effect: Effect.Effect<T, PlatformError, never>) =>
      effect.pipe(
        Effect.catchTag("PlatformError", (e) =>
          e.reason._tag === "NotFound" ? Effect.void : fail(e),
        ),
      );

    const stageDir = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage);

    const resource = ({
      stack,
      stage,
      fqn,
    }: {
      stack: string;
      stage: string;
      fqn: string;
    }) => path.join(stateDir, stack, stage, `${encodeFqn(fqn)}.json`);

    const outputFile = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage, `__stack_output__.json`);

    // Write state files atomically: write to a unique sibling temp file, then
    // rename it over the target. Rename within a directory is atomic on POSIX
    // filesystems, so a concurrent `get` (e.g. a parallel test reading shared
    // `.alchemy/state`) never observes a truncated, mid-write file — which
    // would otherwise surface as `JSON.parse("")` → "Unexpected end of JSON
    // input". The temp suffix is unique per process+call so concurrent writers
    // of the same file don't clobber each other's temp.
    const writeAtomic = (file: string, contents: string) =>
      Effect.suspend(() => {
        const tmp = `${file}.${process.pid}.${Math.random()
          .toString(36)
          .slice(2)}.tmp`;
        return fs.writeFileString(tmp, contents).pipe(
          Effect.flatMap(() => fs.rename(tmp, file)),
          Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)),
        );
      });

    // Parse a state file, tolerating an empty read. A zero-length file can
    // linger from a write that was interrupted before this atomic-write change
    // (or any non-atomic external writer); treat it as "absent" rather than
    // throwing a JSON parse error that would abort the whole operation.
    const parseState = (contents: string) =>
      contents.trim().length === 0
        ? undefined
        : JSON.parse(contents, reviveState);

    const created = new Set<string>();

    const ensure = (dir: string) =>
      created.has(dir)
        ? Effect.succeed(void 0)
        : fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.tap(() => Effect.sync(() => created.add(dir))));

    const state: StateService = {
      id: "local",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        fs.readDirectory(stateDir).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      listStages: (stack: string) =>
        fs.readDirectory(path.join(stateDir, stack)).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      get: (request) =>
        fs.readFile(resource(request)).pipe(
          Effect.map((file) => parseState(file.toString())),
          recover,
        ),
      getReplacedResources: Effect.fn(function* (request) {
        return (yield* Effect.all(
          (yield* state.list(request)).map((fqn) =>
            state.get({
              stack: request.stack,
              stage: request.stage,
              fqn,
            }),
          ),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        ensure(stageDir(request)).pipe(
          Effect.flatMap(() =>
            writeAtomic(
              resource(request),
              JSON.stringify(encodeState(request.value), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
      delete: (request) => fs.remove(resource(request)).pipe(recover),
      deleteStack: ({ stack, stage }) =>
        fs
          .remove(
            stage === undefined
              ? path.join(stateDir, stack)
              : stageDir({ stack, stage }),
            { recursive: true },
          )
          .pipe(recover),
      list: (request) =>
        fs.readDirectory(stageDir(request)).pipe(
          recover,
          Effect.map((files) =>
            (files ?? [])
              // Only decode committed state files. Exclude:
              //  - the `__stack_output__.json` bookkeeping file — `decodeFqn`
              //    turns `__` into `/`, which would slip the literal name past
              //    a bare-name filter and make the engine look up a
              //    non-existent resource;
              //  - in-flight `*.tmp` files written by `writeAtomic` (and any
              //    other non-`.json` entry), which are not resources.
              .filter(
                (file) =>
                  file.endsWith(".json") && file !== "__stack_output__.json",
              )
              .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
          ),
        ),
      getOutput: (request) =>
        fs.readFile(outputFile(request)).pipe(
          Effect.map((file) => parseState(file.toString())),
          recover,
        ),
      setOutput: (request) =>
        ensure(stageDir(request)).pipe(
          Effect.flatMap(() =>
            writeAtomic(
              outputFile(request),
              JSON.stringify(encodeState(request.value as any), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
    };
    return state;
  });
