// @effect-diagnostics nodeBuiltinImport:off
// FileHandle bounds instruction reads even when a file grows while it is open.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

import type {
  AgentSkillCatalog,
  AgentSkillDetail,
  AgentSkillInstallation,
  AgentSkillSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

const MAX_SKILL_CONTENT_BYTES = 512 * 1024;

export class SkillDiscoveryError extends Schema.TaggedError<SkillDiscoveryError>()(
  "SkillDiscoveryError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Skill discovery is busy. Try refreshing again shortly.";
  }
}

export class SkillReadError extends Schema.TaggedError<SkillReadError>()("SkillReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not read ${this.path}`;
  }
}

const readSkillMarkdown = (filePath: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = await NodeFSP.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_SKILL_CONTENT_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_SKILL_CONTENT_BYTES) throw new Error("SKILL.md exceeds 512 KiB");
        return buffer
          .toString("utf8", 0, length)
          .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
          .trim();
      } finally {
        await file.close();
      }
    },
    catch: (cause) => new SkillReadError({ path: filePath, cause }),
  });

export class SkillCatalog extends Context.Service<
  SkillCatalog,
  {
    readonly list: (cwd?: string) => Effect.Effect<AgentSkillCatalog, SkillDiscoveryError>;
    readonly detail: (
      id: string,
      cwd?: string,
    ) => Effect.Effect<Option.Option<AgentSkillDetail>, SkillDiscoveryError | SkillReadError>;
  }
>()("t3/skills/SkillCatalog") {}

export const make = Effect.fn("SkillCatalog.make")(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const catalogCache = yield* Ref.make<
    { cwd: string | undefined; catalog: AgentSkillCatalog } | undefined
  >(undefined);
  const slots = yield* Semaphore.make(2);

  const discover = Effect.fn("SkillCatalog.discover")(function* (cwd: string | undefined) {
    const instances = yield* registry.listInstances;
    const installations: AgentSkillInstallation[] = [];
    const issues: Array<AgentSkillCatalog["issues"][number]> = [];
    // Two catalog requests at most, each probing providers sequentially. The
    // driver owns discovery and its per-instance configuration, never the composer.
    for (const instance of instances) {
      const cached = yield* instance.snapshot.getSnapshot;
      const snapshot = yield* (
        !instance.enabled || !cached.installed
          ? Effect.succeed(cached)
          : cwd !== undefined && instance.snapshotForCwd
            ? instance.snapshotForCwd(cwd)
            : instance.snapshot.refresh
      ).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) => {
          issues.push({
            instanceId: instance.instanceId,
            providerName: instance.displayName ?? instance.driverKind,
            message: cause.message,
          });
          return Effect.succeed(Option.none());
        }),
      );
      if (Option.isNone(snapshot)) continue;
      if (snapshot.value.status === "error") {
        issues.push({
          instanceId: instance.instanceId,
          providerName: instance.displayName ?? instance.driverKind,
          message: snapshot.value.message ?? "Provider discovery failed.",
        });
      }
      for (const skill of snapshot.value.skills) {
        installations.push({
          ...skill,
          instanceId: instance.instanceId,
          provider: instance.driverKind,
          providerName: instance.displayName ?? instance.driverKind,
          providerEnabled: instance.enabled,
        });
      }
    }
    const files = yield* Effect.forEach(
      installations,
      (installation) =>
        Effect.promise(async () => ({
          installation,
          resolvedPath: await NodeFSP.realpath(installation.path).catch(() => null),
        })),
      { concurrency: 8 },
    );
    const groups = new Map<
      string,
      { id: string; resolvedPath: string | null; installations: AgentSkillInstallation[] }
    >();
    for (const { installation, resolvedPath } of files) {
      // Never merge unresolved paths across providers: they may no longer refer
      // to the same file. Names are metadata, not file identity.
      const key =
        resolvedPath === null
          ? `installation:${installation.instanceId}:${installation.path}`
          : `file:${resolvedPath}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          id: NodeCrypto.createHash("sha256").update(key).digest("hex"),
          resolvedPath,
          installations: [],
        };
        groups.set(key, group);
      }
      group.installations.push(installation);
    }
    return { skills: [...groups.values()], issues } satisfies AgentSkillCatalog;
  });

  // Keep cancellation attached to the request. Provider snapshots own their
  // refresh sharing; the catalog only bounds simultaneous discovery requests.
  const list = Effect.fn("SkillCatalog.list")(function* (cwd?: string) {
    const result = yield* slots.withPermitsIfAvailable(1)(discover(cwd));
    if (Option.isNone(result)) return yield* new SkillDiscoveryError({ cause: undefined });
    const catalog = result.value;
    yield* Ref.set(catalogCache, { cwd, catalog });
    return catalog;
  });
  const detail = Effect.fn("SkillCatalog.detail")(function* (id: string, cwd?: string) {
    const cached = yield* Ref.get(catalogCache);
    const catalog = cached?.cwd === cwd && cached !== undefined ? cached.catalog : yield* list(cwd);
    const skill: AgentSkillSummary | undefined = catalog.skills.find((entry) => entry.id === id);
    if (!skill) return Option.none<AgentSkillDetail>();
    // Read the resolved identity, so retargeting a symlink cannot put a different
    // file's instructions beneath the cached group's provider badges.
    const filePath = skill.resolvedPath;
    if (filePath === null)
      return yield* new SkillReadError({
        path: skill.installations[0]?.path ?? id,
        cause: "Installation no longer resolves; refresh the catalog.",
      });
    const content = yield* readSkillMarkdown(filePath);
    return Option.some({ ...skill, content });
  });
  return SkillCatalog.of({ list, detail });
});

export const layer = Layer.effect(SkillCatalog, make());
