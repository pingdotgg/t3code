import {
  resolveProjectProviderInstanceEnabled,
  type ComposerContextRecord,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type ProjectId,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import {
  parsePstackRoleDefaults,
  pstackContentHash,
  pstackPackEntries,
  PSTACK_SKILL_PREFIX,
} from "@t3tools/pstack";
import { parseSkillFrontmatter } from "@t3tools/shared/skillFrontmatter";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { readOrchestrationProviders } from "../provider/orchestrationTargets.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import { planPstackComposer, referencesPstack } from "./composer.ts";
import {
  formatPstackBlock,
  formatPstackLocator,
  parseModelsFile,
  resolveRoles,
} from "./pstackModels.ts";

class PstackPackError extends Schema.TaggedError<PstackPackError>()("PstackPackError", {
  path: Schema.String,
  operation: Schema.Literals(["materialize", "catalog", "expand"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Unable to ${this.operation} the pstack pack.`;
  }
}

const isPstackPackError = Schema.is(PstackPackError);

export class PstackPack extends Context.Service<
  PstackPack,
  {
    readonly catalog: Effect.Effect<ReadonlyArray<ServerProviderSkill> | undefined>;
    readonly expandComposer: (
      input: {
        readonly projectId: ProjectId;
        readonly parentModelSelection?: ModelSelection;
        readonly supportsOrchestrationTools?: boolean;
        readonly text: string;
        readonly records: ReadonlyArray<ComposerContextRecord>;
      },
      message: Pick<
        OrchestrationV2ConversationMessage,
        "createdBy" | "notification" | "delegatedCompletion"
      >,
    ) => Effect.Effect<{
      readonly text: string;
      readonly records: ReadonlyArray<ComposerContextRecord>;
    }>;
  }
>()("t3/pstack/PstackPack") {}

const make = Effect.fn("PstackPack.make")(function* (sourceRoot?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const directory = path.join(config.stateDir, "pstack");
  const packDir = path.join(directory, "pack");
  const modelsPath = path.join(directory, "models.md");
  // Seats saved before proxy mode can name instances that no longer exist.
  yield* fs.readFileString(modelsPath).pipe(
    Effect.flatMap((saved) => {
      const file = saved.replace(
        /\w+(?=\/)/g,
        (instanceId) => ServerSettings.retiredInstanceSuccessor(instanceId) ?? instanceId,
      );
      return file === saved ? Effect.void : fs.writeFileString(modelsPath, file);
    }),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("could not move pstack role seats off retired providers", cause),
    ),
  );
  const stampPath = path.join(packDir, ".t3-pstack-hash");
  const readStamp = fs.readFileString(stampPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.void,
    ),
  );
  const remove = Effect.fn("PstackPack.remove")(function* (target: string) {
    yield* fs
      .remove(target, { recursive: true, force: true })
      .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not clean pstack files", cause)));
  });
  const prune = Effect.fn("PstackPack.prune")(
    function* () {
      const entries = yield* fs.readDirectory(directory);
      for (const entry of entries) {
        const owner = /^\.pack-(?:tmp|trash)-(\d+)-/.exec(entry);
        if (owner && !isProcessAlive(Number(owner[1]))) yield* remove(path.join(directory, entry));
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not prune pstack files", cause)),
  );
  const readMetadata = Effect.fn("PstackPack.readMetadata")(
    function* (from: string) {
      const skills: ServerProviderSkill[] = [];
      const skillsDir = path.join(from, "skills");
      for (const folder of (yield* fs.readDirectory(skillsDir)).sort()) {
        const skillPath = path.join(skillsDir, folder, "SKILL.md");
        if (!(yield* fs.exists(skillPath))) continue;
        const frontmatter = parseSkillFrontmatter(yield* fs.readFileString(skillPath));
        skills.push({
          name: `${PSTACK_SKILL_PREFIX}${folder}`,
          path: path.join(packDir, "skills", folder, "SKILL.md"),
          scope: "t3",
          enabled: true,
          ...(frontmatter.kind === "parsed" && frontmatter.description
            ? { description: frontmatter.description }
            : {}),
          ...(frontmatter.kind === "parsed" && frontmatter.userInvocationOnly
            ? { userInvocationOnly: true }
            : {}),
        });
      }
      const defaults = parsePstackRoleDefaults(
        yield* fs.readFileString(path.join(skillsDir, "setup-pstack/SKILL.md")),
      );
      if (defaults.length === 0)
        return yield* new PstackPackError({
          path: from,
          operation: "catalog",
          cause: "No role defaults in setup-pstack",
        });
      return { skills, defaults };
    },
    Effect.mapError((cause) => new PstackPackError({ path: packDir, operation: "catalog", cause })),
  );
  let cached:
    | { hash: string; metadata: Effect.Success<ReturnType<typeof readMetadata>> }
    | undefined;
  const materializeLock = yield* Semaphore.make(1);
  let source: { root: string; hash: string } | undefined;
  let verifiedOwnStamp = false;
  let warnedForeignStamp: string | undefined;
  const readStampedMetadata = Effect.fn("PstackPack.readStampedMetadata")(function* (hash: string) {
    const metadata = cached?.hash === hash ? cached.metadata : yield* readMetadata(packDir);
    if ((yield* readStamp) !== hash)
      return yield* new PstackPackError({
        path: packDir,
        operation: "materialize",
        cause: "Pack changed while reading",
      });
    cached = { hash, metadata };
    return metadata;
  });
  const readPack = Effect.fn("PstackPack.readPack")(
    function* () {
      if (source === undefined) {
        const root =
          sourceRoot ??
          (yield* ServerConfig.resolvePstackSourceRoot().pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ));
        source = {
          root,
          hash: yield* Effect.try({
            try: () => pstackContentHash(root),
            catch: (cause) => new PstackPackError({ path: root, operation: "materialize", cause }),
          }),
        };
      }
      const { root, hash } = source;
      yield* fs.makeDirectory(directory, { recursive: true });
      const stamp = yield* readStamp;
      if (stamp === hash) {
        const metadata = yield* readStampedMetadata(hash);
        verifiedOwnStamp = true;
        return metadata;
      }
      // A second server version must not repeatedly replace this environment's working pack.
      if (verifiedOwnStamp && stamp !== undefined && /^[a-f0-9]{16}$/.test(stamp)) {
        const metadata = yield* readStampedMetadata(stamp).pipe(Effect.catch(() => Effect.void));
        if (metadata !== undefined) {
          if (warnedForeignStamp !== stamp) {
            yield* Effect.logWarning(
              "Another server version replaced pstack; using the pack on disk",
            );
            warnedForeignStamp = stamp;
          }
          return metadata;
        }
      }
      const metadata = yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* Effect.acquireRelease(
            fs.makeTempDirectory({ directory, prefix: `.pack-tmp-${process.pid}-` }),
            remove,
          );
          const trash = temporary.replace(/\.pack-tmp-([^/\\]+)$/, ".pack-trash-$1");
          const entries = yield* Effect.try({
            try: () => pstackPackEntries(root),
            catch: (cause) => new PstackPackError({ path: root, operation: "materialize", cause }),
          });
          for (const entry of entries) {
            const destination = path.join(temporary, entry.packPath);
            yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
            yield* fs.writeFile(destination, yield* fs.readFile(entry.sourcePath));
            yield* fs.chmod(destination, entry.executable ? 0o755 : 0o644);
          }
          const metadata = yield* readMetadata(temporary);
          yield* fs.writeFileString(path.join(temporary, ".t3-pstack-hash"), hash);
          if ((yield* readStamp) === hash) return metadata;
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* fs.rename(packDir, trash).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  () => Effect.void,
                ),
              );
              yield* fs.rename(temporary, packDir).pipe(
                Effect.catch((error) =>
                  readStamp.pipe(
                    Effect.flatMap((stamp) => (stamp === hash ? Effect.void : Effect.fail(error))),
                  ),
                ),
                Effect.onError(() => fs.rename(trash, packDir).pipe(Effect.ignoreCause)),
                Effect.ensuring(
                  readStamp.pipe(
                    Effect.flatMap((stamp) => (stamp === undefined ? Effect.void : remove(trash))),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Could not clean replaced pstack pack", cause),
                    ),
                  ),
                ),
              );
            }),
          );
          if ((yield* readStamp) !== hash)
            return yield* new PstackPackError({
              path: packDir,
              operation: "materialize",
              cause: "Pack changed during publication",
            });
          return metadata;
        }),
      );
      cached = { hash, metadata };
      verifiedOwnStamp = true;
      return metadata;
    },
    Effect.mapError((cause) =>
      isPstackPackError(cause)
        ? cause
        : new PstackPackError({ path: directory, operation: "materialize", cause }),
    ),
    Effect.retry({ times: 1 }),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const stamp = yield* readStamp;
        if (stamp === undefined || !/^[a-f0-9]{16}$/.test(stamp)) return yield* error;
        const metadata = yield* readStampedMetadata(stamp);
        yield* Effect.logWarning(
          "Could not update pstack; serving the stamped pack and retrying on the next read",
          error,
        );
        return metadata;
      }),
    ),
    materializeLock.withPermits(1),
    Effect.tap(() => prune()),
  );

  const getCatalog = Effect.fn("PstackPack.catalog")(
    function* () {
      if (!(yield* settings.getSettings).pstackEnabled) return undefined;
      return (yield* readPack()).skills;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("pstack catalog is unavailable", cause).pipe(Effect.as(undefined)),
    ),
  );

  const expandComposer: PstackPack["Service"]["expandComposer"] = Effect.fn(
    "PstackPack.expandComposer",
  )(
    function* (input, message) {
      const plan = planPstackComposer(input, message);
      if (plan === undefined && !referencesPstack(input, message)) return input;
      const currentSettings = yield* settings.getSettings;
      if (!currentSettings.pstackEnabled) return input;
      const pack = yield* readPack();
      if (plan === undefined)
        return { ...input, text: `${input.text.trimEnd()}\n\n${formatPstackLocator(packDir)}` };
      const names = new Set(
        plan.skillNames.filter((name) => pack.skills.some((skill) => skill.name === name)),
      );
      if (names.size === 0) return input;
      if (input.supportsOrchestrationTools === false)
        return plan.apply(
          names,
          "pstack is unavailable: this session does not expose T3 orchestration tools. Use a T3-managed session to run this workflow.",
        );
      const file = yield* fs.readFileString(modelsPath).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.void,
        ),
        Effect.mapError(
          (cause) => new PstackPackError({ path: modelsPath, operation: "expand", cause }),
        ),
      );
      const providers = yield* readOrchestrationProviders().pipe(
        Effect.provideService(ProviderRegistry.ProviderRegistry, registry),
        Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, adapters),
      );
      const expansion = formatPstackBlock({
        skillNames: [...names].map((name) => name.slice(PSTACK_SKILL_PREFIX.length)),
        packDir,
        modelsPath,
        resolved: resolveRoles({
          file: file === undefined ? undefined : parseModelsFile(file),
          defaults: pack.defaults,
          settings: currentSettings,
          ...(input.parentModelSelection === undefined
            ? {}
            : { parentModelSelection: input.parentModelSelection }),
          nowMs: yield* Clock.currentTimeMillis,
          ...providers,
          providers: providers.providers.map((provider) => ({
            ...provider,
            enabled:
              provider.enabled &&
              resolveProjectProviderInstanceEnabled(
                currentSettings,
                input.projectId,
                provider.instanceId,
              ),
          })),
        }),
      });
      return plan.apply(names, expansion);
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          const reason = isPstackPackError(error)
            ? error.message
            : "Could not read pstack settings or providers.";
          return Effect.logWarning("pstack expansion is unavailable", cause).pipe(
            Effect.as({ ...input, text: `${input.text}\n\npstack is unavailable: ${reason}` }),
          );
        }),
      ),
  );
  return PstackPack.of({ catalog: getCatalog(), expandComposer });
});

export const layerFromSource = (sourceRoot: string) => Layer.effect(PstackPack, make(sourceRoot));
export const layer = Layer.effect(PstackPack, make());
