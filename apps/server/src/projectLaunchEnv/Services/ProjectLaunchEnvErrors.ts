import * as Schema from "effect/Schema";

export class ProjectLaunchEnvProjectNotFoundError extends Schema.TaggedErrorClass<ProjectLaunchEnvProjectNotFoundError>()(
  "ProjectLaunchEnvProjectNotFoundError",
  {
    projectId: Schema.String,
  },
) {
  override get message(): string {
    return `Project not found: ${this.projectId}`;
  }
}

export class ProjectLaunchEnvProjectStatError extends Schema.TaggedErrorClass<ProjectLaunchEnvProjectStatError>()(
  "ProjectLaunchEnvProjectStatError",
  {
    projectId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to stat project: ${this.projectId}`;
  }
}

export type ProjectLaunchEnvProjectLookupError =
  | ProjectLaunchEnvProjectNotFoundError
  | ProjectLaunchEnvProjectStatError;

export class ProjectLaunchEnvThreadLookupError extends Schema.TaggedErrorClass<ProjectLaunchEnvThreadLookupError>()(
  "ProjectLaunchEnvThreadLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Thread not found: ${this.threadId}`;
  }
}
