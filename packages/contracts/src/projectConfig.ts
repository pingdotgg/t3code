import * as Schema from "effect/Schema";
import { TrimmedString } from "./baseSchemas.ts";
import { ProjectScript } from "./orchestration.ts";

export const PROJECT_CONFIG_RELATIVE_PATH = ".t3code/project.json";
export const PROJECT_CONFIG_SCHEMA_URL = "https://t3.chat/schemas/project.json";

export const ProjectBrowserConfig = Schema.Struct({
  previewUrl: Schema.optional(TrimmedString),
});
export type ProjectBrowserConfig = typeof ProjectBrowserConfig.Type;

export const ProjectConfig = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  browser: Schema.optional(ProjectBrowserConfig),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectConfig = typeof ProjectConfig.Type;
