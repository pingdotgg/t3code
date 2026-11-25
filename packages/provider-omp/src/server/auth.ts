import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

export const makeOmpAuth = Effect.fn("OmpAuth.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly credentialKey: string;
  readonly refresh: Effect.Effect<unknown>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  if (Option.isNone(pty)) return undefined;
  const terminal = pty.value;
  const fs = yield* FileSystem.FileSystem;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    methods: Effect.succeed([
      { id: "terminal", name: "Oh My Pi", description: null, type: "terminal" },
    ]),
    authenticate: Effect.fn("OmpAuth.authenticate")(function* (_method, context) {
      const startFailure = failure("start", "Could not open the Oh My Pi sign-in terminal.");
      const cwd = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-omp-auth-" })
        .pipe(Effect.mapError(() => startFailure));
      const resolved = yield* resolveSpawnCommand(options.binaryPath, ["login"], {
        env: options.environment,
      }).pipe(Effect.mapError(() => startFailure));
      const output = yield* Queue.sliding<string>(64);
      const exited = yield* Deferred.make<number>();
      const process = yield* terminal
        .spawn({
          shell: resolved.command,
          args: [...resolved.args],
          cwd,
          cols: 80,
          rows: 24,
          env: options.environment,
        })
        .pipe(Effect.mapError(() => startFailure));
      const detachData = process.onData((data) => Queue.offerUnsafe(output, data.slice(-16_384)));
      const detachExit = process.onExit(({ exitCode }) => {
        Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          detachData();
          detachExit();
          try {
            process.kill();
          } catch {}
        }),
      );
      let transcript = "";
      let outputOffset = 0;
      const update = () =>
        context.setInteraction(
          {
            type: "terminal",
            id: "terminal",
            output: transcript,
            outputOffset,
          },
          (response) =>
            response.type === "terminal"
              ? Effect.try({
                  try: () => {
                    if (response.size) process.resize(response.size.cols, response.size.rows);
                    if (response.data)
                      process.write(PtyAdapter.ptyInput(response.data, response.binary));
                  },
                  catch: () => failure("respond", "The Oh My Pi sign-in terminal has closed."),
                })
              : Effect.void,
        );
      yield* update();
      yield* Queue.take(output).pipe(
        Effect.flatMap((text) => {
          outputOffset += text.length;
          transcript = (transcript + text).slice(-16_384);
          return update();
        }),
        Effect.forever,
        Effect.forkScoped,
      );
      if ((yield* Deferred.await(exited)) !== 0)
        return yield* failure("start", "Oh My Pi sign-in ended before it completed.");
      yield* context.verifying;
      yield* options.refresh;
    }),
    logout: Effect.fail(failure("logout", "Select an account to remove in the Oh My Pi terminal.")),
  });
});
