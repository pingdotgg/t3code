import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { parse as parseYaml } from "yaml";
import {
  McpServersFile,
  Profile,
  ProfileId,
  type ProfileMcpServer,
  ProfilesFile,
  ProviderSettingsFile,
  type ResolvedProviderSettings,
  type ProfileCatalog,
} from "@t3tools/contracts";

class ProfileLoadError extends Schema.TaggedError<ProfileLoadError>()("ProfileLoadError", {
  path: Schema.String,
  operation: Schema.Literals(["read", "decode", "default"]),
  cause: Schema.Defect(),
  field: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return this.operation === "default"
      ? `Default profile does not exist in ${this.path}.`
      : `Could not ${this.operation} ${this.path}.${this.field ? ` Check field ${this.field}.` : " Check the profiles format and file permissions."}`;
  }
}

const SkillMetadata = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
});
const decodeProfiles = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...ProfilesFile.fields,
      profiles: Schema.Record(ProfileId, Schema.Unknown),
    }),
  ),
);
const decodeProfile = Schema.decodeUnknownEffect(Profile);
const formatFields = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "Invalid field",
  checkHook: () => "Invalid field",
});
const invalidFields = (cause: Schema.SchemaError) =>
  formatFields(cause.issue)
    .issues.map((issue) => issue.path?.join(".") || "profile")
    .join(", ");
const decodeSkillMetadata = Schema.decodeUnknownEffect(SkillMetadata);
const isProfileLoadError = Schema.is(ProfileLoadError);
const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export class Profiles extends Context.Service<
  Profiles,
  {
    readonly load: (folder: string) => Effect.Effect<{
      readonly catalog: ProfileCatalog;
      readonly instructions: Readonly<Record<string, string>>;
      readonly providerSettings: Readonly<Record<string, readonly ResolvedProviderSettings[]>>;
      /** Each profile's selected servers from `mcp-servers.json`, secrets still as references. */
      readonly mcpServers: Readonly<Record<string, Readonly<Record<string, ProfileMcpServer>>>>;
    }>;
  }
>()("t3/profiles/Profiles") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = Effect.fn("Profiles.read")(function* (file: string) {
    return yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((cause) => new ProfileLoadError({ path: file, operation: "read", cause })),
      );
  });
  const load = Effect.fn("Profiles.load")(function* (folder: string) {
    const root = path.resolve(folder);
    const file = path.join(root, "profiles.json");
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file)))
        return {
          catalog: { folder: root, profiles: {} },
          instructions: {},
          providerSettings: {},
          mcpServers: {},
        };
      const config = yield* decodeProfiles(yield* read(file)).pipe(
        Effect.mapError(
          (cause) => new ProfileLoadError({ path: file, operation: "decode", cause }),
        ),
      );
      if (config.default !== undefined && !Object.hasOwn(config.profiles, config.default)) {
        return yield* new ProfileLoadError({ path: file, operation: "default", cause: undefined });
      }
      const settingsFile = path.join(root, "provider-settings.json");
      const settings = yield* fs.exists(settingsFile).pipe(
        Effect.flatMap((exists) =>
          exists
            ? read(settingsFile).pipe(
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ProviderSettingsFile))),
              )
            : Effect.succeed({} as ProviderSettingsFile),
        ),
        Effect.result,
      );
      const mcpFile = path.join(root, "mcp-servers.json");
      const mcp = yield* fs.exists(mcpFile).pipe(
        Effect.flatMap((exists) =>
          exists
            ? read(mcpFile).pipe(
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(McpServersFile))),
              )
            : Effect.succeed<McpServersFile>({ mcpServers: {} }),
        ),
        Effect.result,
      );
      const providerSettings: Record<string, readonly ResolvedProviderSettings[]> = {};
      const mcpServers: Record<string, Record<string, ProfileMcpServer>> = {};
      const instructions: Record<string, string> = {};
      const catalogProfiles: Record<string, ProfileCatalog["profiles"][string]> = {};
      for (const [id, raw] of Object.entries(config.profiles)) {
        let profile: Profile = { prompts: [], skills: [] };
        const loaded = yield* Effect.gen(function* () {
          profile = yield* decodeProfile(raw).pipe(
            Effect.mapError(
              (cause) =>
                new ProfileLoadError({
                  path: file,
                  operation: "decode",
                  field: invalidFields(cause),
                  cause,
                }),
            ),
          );
          const resolved: ResolvedProviderSettings[] = [];
          for (const driver of ["claudeAgent", "codex", "pi"] as const) {
            const name = profile.providerSettings?.[driver];
            if (name === undefined) continue;
            if (settings._tag === "Failure")
              return yield* new ProfileLoadError({
                path: settingsFile,
                operation: "decode",
                cause: settings.failure,
              });
            const entries = settings.success[driver];
            if (!entries || !Object.hasOwn(entries, name))
              return yield* new ProfileLoadError({
                path: settingsFile,
                operation: "decode",
                field: `${driver}.${name}`,
                cause: undefined,
              });
            // The driver selects the matching schema-decoded record above.
            resolved.push({
              _tag: driver,
              id: name,
              settings: entries[name]!,
            } as ResolvedProviderSettings);
          }
          const servers: Record<string, ProfileMcpServer> = {};
          for (const name of profile.mcpServers ?? []) {
            if (mcp._tag === "Failure")
              return yield* new ProfileLoadError({
                path: mcpFile,
                operation: "decode",
                cause: mcp.failure,
              });
            if (!Object.hasOwn(mcp.success.mcpServers, name))
              return yield* new ProfileLoadError({
                path: mcpFile,
                operation: "decode",
                field: `mcpServers.${name}`,
                cause: undefined,
              });
            servers[name] = mcp.success.mcpServers[name]!;
          }
          const parts: string[] = [];
          for (const prompt of profile.prompts)
            parts.push(yield* read(path.join(root, "prompts", `${prompt}.md`)));
          const skills: string[] = [];
          for (const skill of profile.skills) {
            const skillPath = path.join(root, ".agents", "skills", skill, "SKILL.md");
            const content = yield* read(skillPath);
            const rawMetadata = yield* Effect.try({
              try: () => {
                const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
                return parseYaml(match?.[1] ?? "");
              },
              catch: (cause) =>
                new ProfileLoadError({ path: skillPath, operation: "decode", cause }),
            });
            const metadata = yield* decodeSkillMetadata(rawMetadata).pipe(
              Effect.mapError(
                (cause) =>
                  new ProfileLoadError({
                    path: skillPath,
                    operation: "decode",
                    field: invalidFields(cause),
                    cause,
                  }),
              ),
            );
            skills.push(
              `<skill><name>${escapeXml(metadata.name)}</name><description>${escapeXml(metadata.description)}</description><location>${escapeXml(skillPath)}</location></skill>`,
            );
          }
          if (skills.length > 0)
            parts.push(
              `Read a skill's SKILL.md before using it. Resolve relative paths against its directory.\n<available_skills>\n${skills.join("\n")}\n</available_skills>`,
            );
          return { profile, instructions: parts.join("\n\n"), resolved, servers };
        }).pipe(
          Effect.catchTags({
            ProfileLoadError: (error) =>
              Effect.succeed({
                profile: { ...profile, warning: error.message },
                instructions: undefined,
                resolved: undefined,
                servers: undefined,
              }),
          }),
        );
        catalogProfiles[id] = loaded.profile;
        if (loaded.instructions !== undefined) instructions[id] = loaded.instructions;
        if (loaded.resolved !== undefined) providerSettings[id] = loaded.resolved;
        if (loaded.servers !== undefined && Object.keys(loaded.servers).length > 0)
          mcpServers[id] = loaded.servers;
      }
      return {
        catalog: { folder: root, ...config, profiles: catalogProfiles },
        instructions,
        providerSettings,
        mcpServers,
      };
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          catalog: {
            folder: root,
            profiles: {},
            error: isProfileLoadError(cause)
              ? cause.message
              : `Could not read ${file}. Check file permissions.`,
          },
          instructions: {},
          providerSettings: {},
          mcpServers: {},
        }),
      ),
    );
  });
  return Profiles.of({ load });
});

export const layer = Layer.effect(Profiles, make);

export const resolveFolder = (baseDir: string, profilesFolder: string) =>
  profilesFolder || `${baseDir}/profiles`;
