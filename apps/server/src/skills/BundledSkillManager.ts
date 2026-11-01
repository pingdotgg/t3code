import {
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  SkillManagementError,
  type BundledSkillsCatalog,
  type ManagedSkill,
  type ManageBundledSkillInput,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Hex from "effect/encoding/Hex";
import * as Path from "effect/Path";
import * as Settings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { loadBundledSkillSources, type BundledSkillSource } from "./bundledSkillSources.ts";

const MARKER = ".t3-managed-skill.json";
const Marker = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Record(Schema.String, Schema.String),
});
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(Marker));
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(Marker));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);

export class BundledSkillSources extends Context.Reference<
  ReadonlyArray<BundledSkillSource> | undefined
>("t3/skills/BundledSkillSources", { defaultValue: () => undefined }) {}

export class BundledSkillManager extends Context.Service<
  BundledSkillManager,
  {
    readonly catalog: Effect.Effect<BundledSkillsCatalog, SkillManagementError>;
    readonly manage: (
      input: ManageBundledSkillInput,
    ) => Effect.Effect<ManagedSkill, SkillManagementError>;
  }
>()("t3/skills/BundledSkillManager") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* Settings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const sources =
    (yield* BundledSkillSources) ??
    (yield* loadBundledSkillSources().pipe(
      Effect.mapError((cause) => new SkillManagementError({ reason: "filesystem", cause })),
    ));
  const mutex = yield* Semaphore.make(1);
  const hash = Effect.fn("BundledSkillManager.hash")(function* (value: unknown) {
    return Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(encodeJson(value)))
        .pipe(Effect.orDie),
    );
  });
  const io = <A, E>(operation: Effect.Effect<A, E>, target: string) =>
    operation.pipe(
      Effect.mapError(
        (cause) => new SkillManagementError({ reason: "filesystem", path: target, cause }),
      ),
    );
  const targets = Effect.gen(function* () {
    const config = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new SkillManagementError({ reason: "filesystem", cause })),
    );
    const entries = Object.entries(deriveProviderInstanceConfigMap(config)).filter(
      ([, entry]) => entry.driver === "codex" || entry.driver === "claudeAgent",
    );
    return yield* Effect.forEach(entries, ([id, entry]) =>
      Effect.gen(function* () {
        const env = yield* mergeProviderInstanceEnvironment(entry.environment, environment);
        let directory: string;
        if (entry.driver === "codex") {
          const config = yield* decodeCodex(entry.config ?? {}).pipe(
            Effect.mapError(
              (cause) => new SkillManagementError({ reason: "unsupported_provider", cause }),
            ),
          );
          const layout = yield* resolveCodexHomeLayout(config).pipe(
            Effect.provideService(Path.Path, path),
          );
          directory = path.join(
            config.setupMode === "managed" || config.homePath.trim() || config.shadowHomePath.trim()
              ? layout.sharedHomePath
              : path.resolve(
                  expandHomePath(env.CODEX_HOME?.trim() || path.join(home, ".codex"), home),
                ),
            "skills",
          );
        } else {
          const config = yield* decodeClaude(entry.config ?? {}).pipe(
            Effect.mapError(
              (cause) => new SkillManagementError({ reason: "unsupported_provider", cause }),
            ),
          );
          directory = path.join(
            path.resolve(
              expandHomePath(
                config.homePath.trim() ||
                  env.CLAUDE_CONFIG_DIR?.trim() ||
                  path.join(home, ".claude"),
                home,
              ),
            ),
            "skills",
          );
        }
        return {
          instanceId: ProviderInstanceId.make(id),
          label: entry.displayName ?? (entry.driver === "codex" ? "Codex" : "Claude"),
          directory,
        };
      }),
    );
  });

  const observe = Effect.fn("BundledSkillManager.observe")(function* (
    target: string,
    source: BundledSkillSource,
  ) {
    const parent = path.dirname(target);
    const siblings = yield* fs.readDirectory(parent).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as string[]),
      ),
      (effect) => io(effect, parent),
    );
    for (const sibling of siblings.filter((name) => name.startsWith(`.t3-${source.id}-`))) {
      const backupPath = path.join(parent, sibling, "previous");
      if (yield* io(fs.exists(backupPath), backupPath))
        return yield* new SkillManagementError({
          reason: "recovery_required",
          path: target,
          backupPath,
        });
    }
    const link = yield* fs.readLink(target).pipe(Effect.option);
    if (Option.isSome(link))
      return {
        status: "unmanaged" as const,
        fingerprint: yield* hash([target, "link", link.value]),
      };
    const stat = yield* fs.stat(target).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
      (effect) => io(effect, target),
    );
    if (Option.isNone(stat))
      return { status: "not_installed" as const, fingerprint: yield* hash([target, "absent"]) };
    if (stat.value.type !== "Directory")
      return {
        status: "unmanaged" as const,
        fingerprint: yield* hash([target, "file", stat.value.size.toString(), stat.value.mtime]),
      };
    const entries = (yield* io(fs.readDirectory(target), target)).toSorted();
    const contents: Record<string, string> = {};
    for (const name of entries) {
      const file = path.join(target, name);
      const symlink = yield* fs.readLink(file).pipe(Effect.option);
      if (Option.isSome(symlink))
        return {
          status: "unmanaged" as const,
          fingerprint: yield* hash([target, entries, name, "link", symlink.value]),
        };
      const info = yield* io(fs.stat(file), file);
      if (info.type !== "File" || info.size > 1_000_000n) {
        return {
          status: "unmanaged" as const,
          fingerprint: yield* hash([target, entries, name, info.type, info.size.toString()]),
        };
      }
      contents[name] = yield* io(fs.readFileString(file), file);
    }
    const fingerprint = yield* hash([target, contents]);
    const marker = decodeMarker(contents[MARKER]);
    if (Option.isNone(marker)) return { status: "unmanaged" as const, fingerprint };
    const managedNames = Object.keys(marker.value.files).toSorted();
    if (entries.join("\0") !== [...managedNames, MARKER].toSorted().join("\0"))
      return { status: "modified" as const, fingerprint };
    for (const name of managedNames) {
      if ((yield* hash(contents[name])) !== marker.value.files[name])
        return { status: "modified" as const, fingerprint };
    }
    const current =
      managedNames.join("\0") === Object.keys(source.files).toSorted().join("\0") &&
      managedNames.every((name) => contents[name] === source.files[name]);
    return {
      status: current ? ("installed" as const) : ("update_available" as const),
      fingerprint,
    };
  });
  const describe = Effect.fn("BundledSkillManager.describe")(function* (
    directory: string,
    source: BundledSkillSource,
  ) {
    const target = path.join(directory, source.id);
    return {
      id: source.id,
      title: source.title,
      description: source.description,
      ...(source.requirements ? { requirements: source.requirements } : {}),
      path: target,
      ...(yield* observe(target, source)),
    };
  });

  return BundledSkillManager.of({
    catalog: Effect.gen(function* () {
      return {
        targets: yield* Effect.forEach(yield* targets, (target) =>
          Effect.gen(function* () {
            return {
              ...target,
              skills: yield* Effect.forEach(sources, (source) =>
                describe(target.directory, source),
              ),
            };
          }),
        ),
      };
    }).pipe(mutex.withPermits(1)),
    manage: Effect.fn("BundledSkillManager.manage")(function* (input) {
      const target = (yield* targets).find((target) => target.instanceId === input.instanceId);
      const source = sources.find((source) => source.id === input.skillId);
      if (!target || !source)
        return yield* new SkillManagementError({ reason: "unsupported_provider" });
      yield* io(fs.makeDirectory(target.directory, { recursive: true }), target.directory);
      const directory = yield* io(fs.realPath(target.directory), target.directory);
      const destination = path.join(directory, source.id);
      const observedPath = path.join(target.directory, source.id);
      const before = yield* observe(observedPath, source);
      if (before.fingerprint !== input.expectedFingerprint)
        return yield* new SkillManagementError({ reason: "stale_state", path: destination });
      if (before.status === "modified" || before.status === "unmanaged")
        return yield* new SkillManagementError({ reason: "conflict", path: destination });
      if (input.action === "install" && before.status === "installed")
        return yield* describe(target.directory, source);
      if ((input.action === "install") !== (before.status === "not_installed"))
        return yield* new SkillManagementError({ reason: "stale_state", path: destination });
      const stage = yield* io(
        fs.makeTempDirectory({ directory, prefix: `.t3-${source.id}-` }),
        directory,
      );
      const backup = path.join(stage, "previous");
      const replacement = path.join(stage, "next");
      const operation = Effect.gen(function* () {
        if (input.action !== "remove") {
          yield* io(fs.makeDirectory(replacement), replacement);
          const hashes: Record<string, string> = {};
          for (const [name, contents] of Object.entries(source.files)) {
            yield* io(fs.writeFileString(path.join(replacement, name), contents), replacement);
            hashes[name] = yield* hash(contents);
          }
          yield* io(
            fs.writeFileString(
              path.join(replacement, MARKER),
              encodeMarker({ version: 1, files: hashes }),
            ),
            replacement,
          );
        }
        const current = yield* observe(observedPath, source);
        if (current.fingerprint !== before.fingerprint)
          return yield* new SkillManagementError({ reason: "stale_state", path: destination });
        if (before.status !== "not_installed")
          yield* io(fs.rename(destination, backup), destination);
        if (input.action !== "remove") {
          const placed = yield* io(fs.rename(replacement, destination), destination).pipe(
            Effect.result,
          );
          if (placed._tag === "Failure") {
            if (before.status !== "not_installed")
              yield* fs.rename(backup, destination).pipe(
                Effect.mapError(
                  (cause) =>
                    new SkillManagementError({
                      reason: "recovery_required",
                      path: destination,
                      backupPath: backup,
                      cause,
                    }),
                ),
              );
            return yield* placed.failure;
          }
        }
        yield* io(fs.remove(stage, { recursive: true }), stage);
        return yield* describe(target.directory, source);
      });
      return yield* operation.pipe(
        Effect.catchTags({
          SkillManagementError: Effect.fn("BundledSkillManager.cleanupFailure")(function* (
            error: SkillManagementError,
          ) {
            if (error.reason !== "recovery_required")
              yield* fs.remove(stage, { recursive: true }).pipe(Effect.ignore({ log: true }));
            return yield* error;
          }),
        }),
        Effect.uninterruptible,
      );
    }, mutex.withPermits(1)),
  });
});

export const layer = Layer.effect(BundledSkillManager, make);
