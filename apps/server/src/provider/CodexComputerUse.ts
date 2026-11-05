import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type CodexComputerUseAvailability =
  | { readonly status: "available"; readonly skillPath: string }
  | { readonly status: "unavailable" };

const unavailable = { status: "unavailable" } as const;
const pluginId = "computer-use@openai-bundled";
const skillNames = new Set(["computer-use", "computer-use:computer-use"]);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const encodePath = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeConfig = Schema.decodeUnknownEffect(
  Schema.Struct({ config: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeRequirements = Schema.decodeUnknownEffect(
  Schema.Struct({
    requirements: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
);
const decodeSkills = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        cwd: Schema.String,
        errors: Schema.Array(Schema.Struct({ path: Schema.String })),
        skills: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            path: Schema.String,
            enabled: Schema.Boolean,
            pluginId: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  }),
);

const relevantSkill = (value: { name?: unknown; path?: unknown }) =>
  (typeof value.name === "string" && skillNames.has(value.name)) ||
  (typeof value.path === "string" && /(?:^|[/\\])computer-use[/\\]SKILL\.md$/.test(value.path));

export const resolveCodexComputerUse = Effect.fn("CodexComputerUse.resolve")(function* (input: {
  readonly cwd: string | null;
}): Effect.fn.Return<
  CodexComputerUseAvailability,
  never,
  CodexClient.CodexAppServerClient | FileSystem.FileSystem | Path.Path
> {
  if ((yield* HostProcess.Platform) !== "darwin") return unavailable;
  const client = yield* CodexClient.CodexAppServerClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = input.cwd ?? (yield* HostProcess.WorkingDirectory);

  return yield* Effect.gen(function* () {
    const { config } = yield* client.raw
      .request("config/read", { cwd, includeLayers: false })
      .pipe(Effect.flatMap(decodeConfig));
    if (
      record(config.features).plugins === false ||
      record(record(config.plugins)[pluginId]).enabled !== true
    )
      return unavailable;
    const { requirements } = yield* client.raw
      .request("configRequirements/read", {})
      .pipe(Effect.flatMap(decodeRequirements));
    if (
      requirements &&
      (requirements.allowBrowserAndComputerUse === false ||
        (requirements.computerUse != null &&
          (!isRecord(requirements.computerUse) ||
            Object.keys(requirements.computerUse).length > 0)) ||
        record(requirements.featureRequirements).plugins === false)
    )
      return unavailable;

    const node = record(record(config.mcp_servers).node_repl);
    const env = record(node.env);
    if (
      node.enabled === false ||
      (Array.isArray(node.enabled_tools) && !node.enabled_tools.includes("js")) ||
      (Array.isArray(node.disabled_tools) && node.disabled_tools.includes("js")) ||
      typeof node.command !== "string" ||
      !path.isAbsolute(node.command)
    )
      return unavailable;
    const command = path.normalize(node.command);
    if (!command.endsWith("/Contents/Resources/cua_node/bin/node_repl")) return unavailable;
    const resources = path.resolve(path.dirname(command), "../..");
    const modules = path.join(resources, "cua_node/lib/node_modules");
    if (
      env.NODE_REPL_NODE_MODULE_DIRS !== modules ||
      typeof env.NODE_REPL_TRUSTED_SERVICES !== "string"
    )
      return unavailable;
    const services = record(yield* decodeJson(env.NODE_REPL_TRUSTED_SERVICES));
    if (
      services.sky !== "@oai/sky/service" ||
      typeof env.SKY_CUA_SERVICE_PATH !== "string" ||
      !path.isAbsolute(env.SKY_CUA_SERVICE_PATH) ||
      !env.SKY_CUA_SERVICE_PATH.endsWith(".app")
    )
      return unavailable;
    const rules = record(config.skills).config;
    if (
      Array.isArray(rules) &&
      rules.some((rule) => record(rule).enabled === false && relevantSkill(record(rule)))
    )
      return unavailable;

    const catalog = yield* client.raw
      .request("skills/list", { cwds: [cwd] })
      .pipe(Effect.flatMap(decodeSkills));
    const rows = catalog.data.filter((row) => row.cwd === cwd);
    if (rows.length !== 1 || rows.some((row) => row.errors.some(relevantSkill))) return unavailable;
    const skills = rows.flatMap((row) => row.skills).filter(relevantSkill);
    if (skills.some((skill) => !skill.enabled)) return unavailable;
    const discovered = skills.find(
      (skill) => skillNames.has(skill.name) && skill.pluginId === pluginId,
    );
    const skillPath =
      discovered?.path ??
      path.join(
        resources,
        "plugins/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md",
      );
    const quotedPath = yield* encodePath(skillPath);
    if (
      !path.isAbsolute(skillPath) ||
      path.basename(skillPath) !== "SKILL.md" ||
      Buffer.byteLength(quotedPath, "utf8") > 3_000
    )
      return unavailable;

    yield* fileSystem.access(command, { readable: true });
    yield* fileSystem.access(
      path.join(env.SKY_CUA_SERVICE_PATH, "Contents/MacOS/SkyComputerUseService"),
      { readable: true },
    );
    const skyRoot = path.join(modules, "@oai/sky");
    const pkg = record(
      yield* fileSystem
        .readFileString(path.join(skyRoot, "package.json"))
        .pipe(Effect.flatMap(decodeJson)),
    );
    const serviceExport = record(pkg.exports)["./service"];
    if (
      pkg.name !== "@oai/sky" ||
      typeof serviceExport !== "string" ||
      !serviceExport.startsWith("./")
    )
      return unavailable;
    const servicePath = path.resolve(skyRoot, serviceExport);
    if (!servicePath.startsWith(`${skyRoot}/`)) return unavailable;
    yield* fileSystem.access(servicePath, { readable: true });
    const skill = yield* fileSystem.readFileString(skillPath);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1];
    if (
      frontmatter === undefined ||
      !/^name:\s*["']?(?:computer-use|computer-use:computer-use)["']?\s*$/m.test(frontmatter)
    )
      return unavailable;
    return { status: "available", skillPath } as const;
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => unavailable),
  );
});
