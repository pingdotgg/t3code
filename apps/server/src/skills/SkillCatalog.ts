// @effect-diagnostics nodeBuiltinImport:off
// Node FileHandle keeps bounded reads and descriptor cleanup in one try/finally.
// The CLI also needs a private npm prefix independent of the selected project.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { AgentSkillDetail, AgentSkillScope, AgentSkillSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Semaphore from "effect/Semaphore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

import * as ProcessRunner from "../processRunner.ts";

const MAX_CATALOG_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_CONTENT_BYTES = 512 * 1024;

const CliSkillEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  scope: Schema.Literals(["project", "global"]),
  agents: Schema.Array(Schema.String),
  source: Schema.NullOr(Schema.String),
  sourceUrl: Schema.NullOr(Schema.String),
  sourceType: Schema.NullOr(Schema.String),
});

const decodeCliSkills = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(CliSkillEntry)),
);

export class SkillDiscoveryError extends Schema.TaggedError<SkillDiscoveryError>()(
  "SkillDiscoveryError",
  {
    stage: Schema.Literals(["prepare", "execute", "output", "decode", "busy"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.stage === "busy"
      ? "Skill discovery is busy. Try refreshing again shortly."
      : `Could not discover skills (${this.stage})`;
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

type SkillCatalogError = SkillDiscoveryError | SkillReadError;

class DiscoveryKey extends Data.Class<{
  readonly scope: AgentSkillScope;
  readonly cwd: string | undefined;
}> {}

function frontmatterBlock(content: string): RegExpExecArray | null {
  return /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
}

function skillDescriptionFromMarkdown(content: string): string {
  const match = frontmatterBlock(content);
  if (!match?.[1]) return "";
  try {
    const frontmatter: unknown = parseYaml(match[1]);
    if (typeof frontmatter !== "object" || frontmatter === null) return "";
    const description = Reflect.get(frontmatter, "description");
    return typeof description === "string" ? description.trim() : "";
  } catch {
    return "";
  }
}

function skillBodyFromMarkdown(content: string): string {
  const match = frontmatterBlock(content);
  return (match ? content.slice(match[0].length) : content).trim();
}

const readSkillMarkdown = (skillPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const filePath = NodePath.join(skillPath, "SKILL.md");
      const file = await NodeFSP.open(filePath, "r");
      try {
        // Read one extra byte to detect growth without allocating based on file size.
        const buffer = Buffer.alloc(MAX_SKILL_CONTENT_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_SKILL_CONTENT_BYTES) {
          throw new Error(`SKILL.md exceeds ${MAX_SKILL_CONTENT_BYTES} bytes`);
        }
        return buffer.toString("utf8", 0, length);
      } finally {
        await file.close();
      }
    },
    catch: (cause) => new SkillReadError({ path: NodePath.join(skillPath, "SKILL.md"), cause }),
  });

export class SkillCatalog extends Context.Service<
  SkillCatalog,
  {
    readonly list: (
      cwd?: string,
    ) => Effect.Effect<ReadonlyArray<AgentSkillSummary>, SkillCatalogError>;
    readonly detail: (
      scope: AgentSkillScope,
      name: string,
      cwd?: string,
    ) => Effect.Effect<Option.Option<AgentSkillDetail>, SkillCatalogError>;
  }
>()("t3/skills/SkillCatalog") {}

export const make = Effect.fn("SkillCatalog.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const catalogCache = yield* Ref.make<
    Option.Option<{
      readonly cwd: string | undefined;
      readonly skills: ReadonlyArray<AgentSkillSummary>;
    }>
  >(Option.none());

  const discoverUncached = Effect.fn("SkillCatalog.discoverScope")(function* (
    scope: AgentSkillScope,
    cwd?: string,
  ) {
    // npm exec resolves packages and bins from its prefix. An empty prefix prevents
    // a project's installed skills package or executable from shadowing the pinned CLI.
    const prefix = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skills-cli-")),
        catch: (cause) => new SkillDiscoveryError({ stage: "prepare", cause }),
      }),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const result = yield* runner
      .run({
        command: "npx",
        cwd,
        args: [
          "--yes",
          "--ignore-scripts",
          "--prefix",
          prefix,
          "--package=skills@1.5.23",
          "--",
          "skills",
          "list",
          ...(scope === "global" ? ["--global"] : []),
          "--json",
        ],
        timeout: "30 seconds",
        maxOutputBytes: MAX_CATALOG_OUTPUT_BYTES,
        env: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      })
      .pipe(Effect.mapError((cause) => new SkillDiscoveryError({ stage: "execute", cause })));

    if (result.code !== 0 || result.stdoutTruncated || result.stdoutInvalidUtf8) {
      return yield* new SkillDiscoveryError({ stage: "output", cause: result.stderr });
    }

    const entries = yield* decodeCliSkills(result.stdout).pipe(
      Effect.mapError((cause) => new SkillDiscoveryError({ stage: "decode", cause })),
    );

    return yield* Effect.forEach(
      entries.filter((entry) => entry.scope === scope),
      (entry) =>
        readSkillMarkdown(entry.path).pipe(
          Effect.map((content): AgentSkillSummary => ({
            ...entry,
            description: skillDescriptionFromMarkdown(content),
          })),
          // A skill can disappear between CLI discovery and this read. Keep it
          // visible and let the detail request report the failed read if selected.
          Effect.orElseSucceed((): AgentSkillSummary => ({ ...entry, description: "" })),
        ),
      { concurrency: 8 },
    );
  }, Effect.scoped);

  const discoverySlots = yield* Semaphore.make(2);
  // Only in-progress requests are shared: Refresh must see filesystem changes.
  // Refuse excess distinct work before allocating prefixes or spawning processes.
  const discoveries = yield* Cache.makeWith(
    (key: DiscoveryKey) =>
      discoverySlots
        .withPermitsIfAvailable(1)(discoverUncached(key.scope, key.cwd))
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => new SkillDiscoveryError({ stage: "busy", cause: undefined }),
              onSome: Effect.succeed,
            }),
          ),
        ),
    { capacity: 32, timeToLive: () => 0 },
  );
  const discoverScope = (scope: AgentSkillScope, cwd?: string) =>
    Cache.get(discoveries, new DiscoveryKey({ scope, cwd }));

  const list = Effect.fn("SkillCatalog.list")(function* (cwd?: string) {
    const scopes = cwd === undefined ? (["global"] as const) : (["project", "global"] as const);
    const skills = (yield* Effect.forEach(scopes, (scope) => discoverScope(scope, cwd), {
      concurrency: "unbounded",
    })).flat();
    yield* Ref.set(catalogCache, Option.some({ cwd, skills }));
    return skills;
  });

  const detail = Effect.fn("SkillCatalog.detail")(function* (
    scope: AgentSkillScope,
    name: string,
    cwd?: string,
  ) {
    if (scope === "project" && cwd === undefined) return Option.none<AgentSkillDetail>();
    const cached = yield* Ref.get(catalogCache);
    const skills =
      Option.isSome(cached) && cached.value.cwd === cwd
        ? cached.value.skills.filter((skill) => skill.scope === scope)
        : yield* discoverScope(scope, cwd);
    const summary = skills.find((skill) => skill.name === name);
    if (!summary) return Option.none<AgentSkillDetail>();
    const markdown = yield* readSkillMarkdown(summary.path);
    return Option.some({ ...summary, content: skillBodyFromMarkdown(markdown) });
  });

  return SkillCatalog.of({ list, detail });
});

export const layer = Layer.effect(SkillCatalog, make());
