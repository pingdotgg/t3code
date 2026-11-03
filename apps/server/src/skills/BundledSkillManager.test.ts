import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Settings from "../serverSettings.ts";
import * as Skills from "./BundledSkillManager.ts";
import { BUNDLED_SKILL_METADATA, type BundledSkillSource } from "./bundledSkillSources.ts";

const source: BundledSkillSource = {
  ...BUNDLED_SKILL_METADATA[0],
  files: { "SKILL.md": "original skill\n", LICENSE: "MIT\n" },
};
const instanceId = ProviderInstanceId.make("codex");
const getManager = (home: string, sources: ReadonlyArray<BundledSkillSource> = [source]) =>
  Skills.BundledSkillManager.pipe(
    Effect.provide(
      Skills.layer.pipe(
        Layer.provide(
          Settings.layerTest({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                config: { homePath: `${home}/codex` },
              },
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: `${home}/claude` },
              },
            },
          }),
        ),
        Layer.provide(Layer.succeed(Skills.BundledSkillSources, sources)),
      ),
    ),
  );

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-test-" });
  return { fs, path, home, manager: yield* getManager(home) };
});
const skill = Effect.fn("test.skill")(function* (manager: Skills.BundledSkillManager["Service"]) {
  return (yield* manager.catalog).targets.find((target) => target.instanceId === instanceId)!
    .skills[0]!;
});
const install = Effect.fn("test.install")(function* (
  manager: Skills.BundledSkillManager["Service"],
) {
  const current = yield* skill(manager);
  return yield* manager.manage({
    instanceId,
    skillId: current.id,
    action: "install",
    expectedFingerprint: current.fingerprint,
  });
});

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(SecretResolver.SecretResolver, {
      read: () => Effect.succeed([]),
      invalidate: () => Effect.void,
    }),
  ),
)("bundled skill installation", (it) => {
  it.effect("managed Codex uses its shared home instead of inherited CODEX_HOME", () =>
    Effect.gen(function* () {
      const { home, path } = yield* setup;
      const manager = yield* Skills.BundledSkillManager.pipe(
        Effect.provide(
          Skills.layer.pipe(
            Layer.provide(
              Settings.layerTest({
                providerInstances: {
                  [instanceId]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: { setupMode: "managed" },
                    environment: [
                      { name: "CODEX_HOME", value: `${home}/wrong-home`, sensitive: false },
                    ],
                  },
                },
              }),
            ),
            Layer.provide(Layer.succeed(Skills.BundledSkillSources, [source])),
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
          ),
        ),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      const current = yield* skill(manager).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(current.path).toBe(path.join(home, ".codex", "skills", source.id));
      const installed = yield* install(manager).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(installed.path).toBe(current.path);
    }),
  );
  it.effect("includes default providers when no provider overrides have been saved", () =>
    Effect.gen(function* () {
      const { home } = yield* setup;
      const catalog = yield* Effect.gen(function* () {
        const manager = yield* Skills.BundledSkillManager;
        return yield* manager.catalog;
      }).pipe(
        Effect.provide(
          Skills.layer.pipe(
            Layer.provide(Settings.layerTest()),
            Layer.provide(Layer.succeed(Skills.BundledSkillSources, [source])),
          ),
        ),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
      expect(catalog.targets.map((target) => target.instanceId).toSorted()).toEqual([
        "claudeAgent",
        "codex",
      ]);
      expect(
        catalog.targets.every(
          (target) => target.skills.length === 1 && target.skills[0]!.status === "not_installed",
        ),
      ).toBe(true);
    }),
  );
  it.effect(
    "installs, recognizes an update from a new bundle, and removes only its managed copy",
    () =>
      Effect.gen(function* () {
        const { fs, home, manager } = yield* setup;
        expect((yield* skill(manager)).status).toBe("not_installed");
        const installed = yield* install(manager);
        expect(installed.status).toBe("installed");
        expect(installed.requirements).toBe(source.requirements);
        expect(yield* fs.readFileString(`${installed.path}/SKILL.md`)).toBe("original skill\n");
        const next = yield* getManager(home, [
          { ...source, files: { ...source.files, "SKILL.md": "updated skill\n" } },
        ]);
        const outdated = yield* skill(next);
        expect(outdated.status).toBe("update_available");
        const updated = yield* next.manage({
          instanceId,
          skillId: source.id,
          action: "update",
          expectedFingerprint: outdated.fingerprint,
        });
        expect(updated.status).toBe("installed");
        expect(yield* fs.readFileString(`${updated.path}/SKILL.md`)).toBe("updated skill\n");
        yield* fs.writeFileString(`${home}/codex/skills/unrelated.txt`, "keep");
        const removed = yield* next.manage({
          instanceId,
          skillId: source.id,
          action: "remove",
          expectedFingerprint: updated.fingerprint,
        });
        expect(removed.status).toBe("not_installed");
        expect(yield* fs.readFileString(`${home}/codex/skills/unrelated.txt`)).toBe("keep");
      }),
  );
  it.effect("preserves edited skills, added files, and stale views", () =>
    Effect.gen(function* () {
      const { fs, manager } = yield* setup;
      const installed = yield* install(manager);
      yield* fs.writeFileString(`${installed.path}/SKILL.md`, "my edits");
      expect((yield* skill(manager)).status).toBe("modified");
      const stale = yield* manager
        .manage({
          instanceId,
          skillId: source.id,
          action: "update",
          expectedFingerprint: installed.fingerprint,
        })
        .pipe(Effect.flip);
      expect(stale.reason).toBe("stale_state");
      const edited = yield* skill(manager);
      const conflict = yield* manager
        .manage({
          instanceId,
          skillId: source.id,
          action: "remove",
          expectedFingerprint: edited.fingerprint,
        })
        .pipe(Effect.flip);
      expect(conflict.reason).toBe("conflict");
      expect(yield* fs.readFileString(`${installed.path}/SKILL.md`)).toBe("my edits");
      yield* fs.writeFileString(`${installed.path}/SKILL.md`, source.files["SKILL.md"]!);
      yield* fs.writeFileString(`${installed.path}/notes.txt`, "keep notes");
      expect((yield* skill(manager)).status).toBe("modified");
    }),
  );
  it.effect(
    "binds an action to its installation path even when two copies have identical contents",
    () =>
      Effect.gen(function* () {
        const { home, manager } = yield* setup;
        const first = yield* install(manager);
        const other = yield* getManager(`${home}/other-profile`);
        const second = yield* install(other);
        expect(first.fingerprint).not.toBe(second.fingerprint);
        const error = yield* other
          .manage({
            instanceId,
            skillId: source.id,
            action: "remove",
            expectedFingerprint: first.fingerprint,
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("stale_state");
        expect((yield* skill(other)).status).toBe("installed");
      }),
  );
  it.effect("refuses unrelated folders and symlinks, including dangling links", () =>
    Effect.gen(function* () {
      const { fs, home, manager } = yield* setup;
      const destination = `${home}/codex/skills/${source.id}`;
      yield* fs.makeDirectory(destination, { recursive: true });
      yield* fs.writeFileString(`${destination}/SKILL.md`, "custom");
      const observed = yield* skill(manager);
      expect(observed.status).toBe("unmanaged");
      expect(
        (yield* manager
          .manage({
            instanceId,
            skillId: source.id,
            action: "install",
            expectedFingerprint: observed.fingerprint,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      yield* fs.rename(destination, `${home}/custom`);
      yield* fs.symlink(`${home}/custom`, destination);
      expect((yield* skill(manager)).status).toBe("unmanaged");
      yield* fs.remove(destination);
      yield* fs.symlink(`${home}/missing`, destination);
      expect((yield* skill(manager)).status).toBe("unmanaged");
    }),
  );
  it.effect("keeps committed changes usable when staging cleanup fails", () =>
    Effect.gen(function* () {
      const { fs, home } = yield* setup;
      const faultyFs = FileSystem.make({
        ...fs,
        remove: (target, options) =>
          target.includes(".t3-")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                }),
              )
            : fs.remove(target, options),
      });
      const manager = yield* getManager(home).pipe(
        Effect.provideService(FileSystem.FileSystem, faultyFs),
      );
      const installed = yield* install(manager);
      expect(installed.status).toBe("installed");
      const next = yield* getManager(home, [
        { ...source, files: { "SKILL.md": "updated skill\n" } },
      ]).pipe(Effect.provideService(FileSystem.FileSystem, faultyFs));
      const outdated = yield* skill(next);
      const updated = yield* next.manage({
        instanceId,
        skillId: outdated.id,
        action: "update",
        expectedFingerprint: outdated.fingerprint,
      });
      expect(updated.status).toBe("installed");
      expect(yield* fs.readFileString(updated.path + "/SKILL.md")).toBe("updated skill\n");
      const removed = yield* next.manage({
        instanceId,
        skillId: updated.id,
        action: "remove",
        expectedFingerprint: updated.fingerprint,
      });
      expect(removed.status).toBe("not_installed");
      expect((yield* skill(next)).status).toBe("not_installed");
    }),
  );
  it.effect("restores the previous version if replacing it fails", () =>
    Effect.gen(function* () {
      const { fs, path, home, manager } = yield* setup;
      const installed = yield* install(manager);
      const failing = yield* getManager(home, [
        { ...source, files: { ...source.files, "SKILL.md": "new version" } },
      ]).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            path.basename(from) === "next"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: to,
                  }),
                )
              : fs.rename(from, to),
        }),
      );
      const current = yield* skill(failing);
      const error = yield* failing
        .manage({
          instanceId,
          skillId: source.id,
          action: "update",
          expectedFingerprint: current.fingerprint,
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("filesystem");
      expect(yield* fs.readFileString(`${installed.path}/SKILL.md`)).toBe("original skill\n");
    }),
  );
  it.effect(
    "reports a preserved backup after an interrupted swap instead of installing over it",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, manager } = yield* setup;
        const installed = yield* install(manager);
        const stage = path.join(home, "codex", "skills", `.t3-${source.id}-interrupted`);
        yield* fs.makeDirectory(stage);
        yield* fs.rename(installed.path, `${stage}/previous`);
        const error = yield* manager.catalog.pipe(Effect.flip);
        expect(error.reason).toBe("recovery_required");
        expect(error.backupPath).toBe(path.join(stage, "previous"));
        expect(yield* fs.readFileString(`${stage}/previous/SKILL.md`)).toBe("original skill\n");
        yield* fs.rename(path.join(stage, "previous"), installed.path);
        const failing = yield* getManager(home).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              path.basename(to) === "committed"
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                    }),
                  )
                : fs.rename(from, to),
          }),
        );
        const current = yield* skill(failing);
        const failedRemoval = yield* failing
          .manage({
            instanceId,
            skillId: current.id,
            action: "remove",
            expectedFingerprint: current.fingerprint,
          })
          .pipe(Effect.flip);
        expect(failedRemoval.reason).toBe("recovery_required");
        expect(yield* fs.readFileString(path.join(failedRemoval.backupPath!, "SKILL.md"))).toBe(
          "original skill\n",
        );
        expect((yield* failing.catalog.pipe(Effect.flip)).reason).toBe("recovery_required");
      }),
  );
  it.effect("resolves the provider's configured and environment-specific homes on the server", () =>
    Effect.gen(function* () {
      const { home, path } = yield* setup;
      const manager = yield* Skills.BundledSkillManager.pipe(
        Effect.provide(
          Skills.layer.pipe(
            Layer.provide(
              Settings.layerTest({
                providerInstances: {
                  [instanceId]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: { homePath: "", shadowHomePath: "" },
                    environment: [
                      { name: "CODEX_HOME", value: `${home}/custom-codex`, sensitive: false },
                    ],
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: "" },
                    environment: [
                      {
                        name: "CLAUDE_CONFIG_DIR",
                        value: `${home}/custom-claude`,
                        sensitive: false,
                      },
                    ],
                  },
                },
              }),
            ),
            Layer.provide(Layer.succeed(Skills.BundledSkillSources, [source])),
          ),
        ),
      );
      const catalog = yield* manager.catalog;
      expect(catalog.targets.find((target) => target.instanceId === "codex")?.directory).toBe(
        path.join(home, "custom-codex", "skills"),
      );
      expect(catalog.targets.find((target) => target.instanceId === "claudeAgent")?.directory).toBe(
        path.join(home, "custom-claude", "skills"),
      );
      for (const driver of ["codex", "claudeAgent"] as const) {
        const name = driver === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
        for (const reference of ["home", "missing"]) {
          const secretManager = yield* Skills.BundledSkillManager.pipe(
            Effect.provide(
              Skills.layer.pipe(
                Layer.provide(
                  Layer.succeed(SecretResolver.SecretResolver, {
                    read: (references) =>
                      Effect.succeed(
                        references.map((ref) =>
                          ref.reference === "home" ? path.join(home, "secret-home") : undefined,
                        ),
                      ),
                    invalidate: () => Effect.void,
                  }),
                ),
                Layer.provide(
                  Settings.layerTest({
                    providerInstances: {
                      [instanceId]: {
                        driver: ProviderDriverKind.make(driver),
                        environment: [
                          {
                            name,
                            value: { provider: SecretProviderId.make("vault"), reference },
                            sensitive: true,
                          },
                        ],
                      },
                      [ProviderInstanceId.make("invalid")]: {
                        driver: ProviderDriverKind.make(driver),
                        config: { homePath: 42 },
                      },
                    },
                  }),
                ),
                Layer.provide(Layer.succeed(Skills.BundledSkillSources, [source])),
              ),
            ),
            Effect.provideService(HostProcess.Environment, {}),
          );
          const targets = (yield* secretManager.catalog).targets;
          expect(targets.some((target) => target.instanceId === "invalid")).toBe(false);
          expect(targets.find((target) => target.instanceId === instanceId)?.directory).toBe(
            reference === "home" ? path.join(home, "secret-home", "skills") : undefined,
          );
        }
        for (const value of ["~/profile", "relative-profile"]) {
          const relativeManager = yield* Skills.BundledSkillManager.pipe(
            Effect.provide(
              Skills.layer.pipe(
                Layer.provide(
                  Settings.layerTest({
                    providerInstances: {
                      [instanceId]: { driver: ProviderDriverKind.make(driver) },
                    },
                  }),
                ),
                Layer.provide(Layer.succeed(Skills.BundledSkillSources, [source])),
              ),
            ),
            Effect.provideService(HostProcess.Environment, { [name]: value }),
            Effect.provideService(HostProcess.HomeDirectory, home),
          );
          expect(
            (yield* relativeManager.catalog).targets.find(
              (target) => target.instanceId === instanceId,
            )?.directory,
          ).toBe(
            driver === "codex" && value === "~/profile"
              ? path.join(home, "profile", "skills")
              : undefined,
          );
        }
      }
    }),
  );
});
