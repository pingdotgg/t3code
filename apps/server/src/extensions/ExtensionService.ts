import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as Deferred from "effect/Deferred";
import {
  EXTENSION_DEVELOPMENT_SKILL,
  EXTENSION_DEVELOPMENT_REFERENCE,
} from "@t3tools/provider-core/server/extensionDevelopmentSkill";
import * as FileSystem from "effect/FileSystem";
import { ExtensionError, type ExtensionInfo, type ExtensionInvokeInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as ServerConfig from "../config.ts";
import * as ExtensionEvents from "./ExtensionEvents.ts";
import * as ExtensionHostAdapter from "./ExtensionHostAdapter.ts";
import { ExtensionRegistry } from "./ExtensionRegistry.ts";

const isExtensionError = Schema.is(ExtensionError);

export class ExtensionService extends Context.Service<
  ExtensionService,
  {
    readonly developmentSkill: Effect.Effect<{
      path: string;
      content: string;
      referencePath: string;
    }>;
    readonly list: Effect.Effect<readonly ExtensionInfo[], ExtensionError>;
    readonly changes: Stream.Stream<readonly ExtensionInfo[], ExtensionError>;
    readonly install: (input: {
      source: string;
      sourceType: "local" | "npm";
    }) => Effect.Effect<readonly ExtensionInfo[], ExtensionError>;
    readonly manage: (input: {
      id: string;
      action: "enable" | "disable" | "reload" | "update" | "uninstall";
    }) => Effect.Effect<readonly ExtensionInfo[], ExtensionError>;
    readonly setSettings: (input: {
      id: string;
      settings: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<readonly ExtensionInfo[], ExtensionError>;
    readonly invoke: (input: ExtensionInvokeInput) => Effect.Effect<unknown, ExtensionError>;
    readonly panel: (input: {
      id: string;
      panelId: string;
      runtimeId?: string | undefined;
    }) => Effect.Effect<string, ExtensionError>;
  }
>()("t3/extensions/ExtensionService") {}

export const layer = Layer.effect(
  ExtensionService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const skillDirectory = `${config.stateDir}/skills/t3-extension-development`;
    yield* fs.makeDirectory(skillDirectory, { recursive: true });
    const skillPath = `${skillDirectory}/SKILL.md`;
    yield* fs.writeFileString(skillPath, EXTENSION_DEVELOPMENT_SKILL);
    yield* fs.makeDirectory(`${skillDirectory}/references`, { recursive: true });
    const referencePath = `${skillDirectory}/references/api.md`;
    yield* fs.writeFileString(referencePath, EXTENSION_DEVELOPMENT_REFERENCE);
    const bridge = yield* ExtensionHostAdapter.ExtensionHostAdapter;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const initialized = yield* Deferred.make<void, ExtensionError>();
    const updates = yield* Queue.unbounded<readonly ExtensionInfo[]>();
    const pubsub = yield* PubSub.sliding<readonly ExtensionInfo[]>(1);
    const invoke = <A>(operation: string, id: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          isExtensionError(cause)
            ? cause
            : new ExtensionError({
                operation,
                id,
                reason: "runtime-failed",
                cause,
              }),
      });
    const registry = new ExtensionRegistry(`${config.stateDir}/extensions`, {
      launch: bridge.launch,
      platform: bridge.platform,
      hostCall: bridge.call,
      installPackage: bridge.installPackage,
      changed: (entries) => {
        Queue.offerUnsafe(updates, entries);
      },
      event: (id, event) => {
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          typeof event.type === "string" &&
          "data" in event
        )
          void registry.publish({ type: `extension.${id}.${event.type}`, data: event.data });
      },
      log: (id, chunk) => {
        process.stderr.write(`[extension:${id}] ${chunk.slice(0, 8192)}`);
      },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => registry.close()));
    yield* Stream.fromQueue(updates).pipe(
      Stream.runForEach((entries) => PubSub.publish(pubsub, entries)),
      Effect.forkScoped,
    );
    yield* Deferred.complete(
      initialized,
      startup.awaitCommandReady.pipe(
        Effect.mapError(
          (cause) =>
            new ExtensionError({
              operation: "startup",
              id: "registry",
              reason: "runtime-failed",
              cause,
            }),
        ),
        Effect.andThen(invoke("initialize", "registry", () => registry.initialize())),
      ),
    ).pipe(Effect.forkScoped);
    yield* ExtensionEvents.run((event) => {
      void registry.publish(event);
    }).pipe(Effect.forkScoped);
    return {
      developmentSkill: Effect.succeed({
        path: skillPath,
        content: EXTENSION_DEVELOPMENT_SKILL,
        referencePath,
      }),
      list: Deferred.await(initialized).pipe(Effect.map(() => registry.list())),
      changes: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          yield* Deferred.await(initialized);
          return Stream.concat(
            Stream.succeed(registry.list()),
            Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
              Stream.map(() => registry.list()),
            ),
          );
        }),
      ),
      install: Effect.fn("ExtensionService.install")(function* (input) {
        yield* Deferred.await(initialized);
        const source =
          input.sourceType === "local"
            ? expandHomePath(input.source, yield* HostProcess.HomeDirectory)
            : input.source;
        return yield* invoke("install", input.source, () =>
          registry.install(source, input.sourceType),
        );
      }),
      manage: Effect.fn("ExtensionService.manage")((input) =>
        Deferred.await(initialized).pipe(
          Effect.andThen(
            invoke(input.action, input.id, () => registry.manage(input.id, input.action)),
          ),
        ),
      ),
      setSettings: Effect.fn("ExtensionService.settings")((input) =>
        Deferred.await(initialized).pipe(
          Effect.andThen(
            invoke("settings", input.id, () => registry.setSettings(input.id, input.settings)),
          ),
        ),
      ),
      invoke: Effect.fn("ExtensionService.invoke")((input) =>
        Deferred.await(initialized).pipe(
          Effect.andThen(invoke("invoke", input.id, () => registry.invoke(input))),
        ),
      ),
      panel: Effect.fn("ExtensionService.panel")((input) =>
        Deferred.await(initialized).pipe(
          Effect.andThen(
            invoke("panel", input.id, () =>
              registry.panel(input.id, input.panelId, input.runtimeId),
            ),
          ),
        ),
      ),
    } satisfies ExtensionService["Service"];
  }),
);
