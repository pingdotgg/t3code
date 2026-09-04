import * as Schema from "effect/Schema";

export class ServerCliCommandExitError extends Schema.TaggedErrorClass<ServerCliCommandExitError>()(
  "ServerCliCommandExitError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `Command exited with non-zero exit code (${this.exitCode})`;
  }
}

export class ServerCliPublishIconSourceMissingError extends Schema.TaggedErrorClass<ServerCliPublishIconSourceMissingError>()(
  "ServerCliPublishIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing publish icon source: ${this.sourcePath}`;
  }
}

export class ServerCliPublishIconTargetMissingError extends Schema.TaggedErrorClass<ServerCliPublishIconTargetMissingError>()(
  "ServerCliPublishIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing publish icon target: ${this.targetPath}. Run the build subcommand first.`;
  }
}

export class ServerCliDevelopmentIconSourceMissingError extends Schema.TaggedErrorClass<ServerCliDevelopmentIconSourceMissingError>()(
  "ServerCliDevelopmentIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon source: ${this.sourcePath}`;
  }
}

export class ServerCliDevelopmentIconTargetMissingError extends Schema.TaggedErrorClass<ServerCliDevelopmentIconTargetMissingError>()(
  "ServerCliDevelopmentIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon target: ${this.targetPath}. Build web first.`;
  }
}

export class ServerCliBuildAssetMissingError extends Schema.TaggedErrorClass<ServerCliBuildAssetMissingError>()(
  "ServerCliBuildAssetMissingError",
  {
    assetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing build asset: ${this.assetPath}. Run the build subcommand first.`;
  }
}

export class ServerCliEagerBunImportError extends Schema.TaggedErrorClass<ServerCliEagerBunImportError>()(
  "ServerCliEagerBunImportError",
  {
    imports: Schema.Array(Schema.String),
    eagerChunkCount: Schema.Int,
  },
) {
  override get message(): string {
    return `The bundle imports Bun modules from chunks Node loads eagerly (${this.eagerChunkCount} scanned): ${this.imports.join(", ")}. Node cannot resolve a \`bun:\` specifier, so every \`node bin.mjs\` would fail with ERR_UNSUPPORTED_ESM_URL_SCHEME. @effect/platform-bun and @effect/sql-sqlite-bun are inlined so a Bun-hosted server shares one effect instance with the bundle; that requires every path into them to stay behind a runtime-conditional dynamic import. Something now imports one of them statically.`;
  }
}
