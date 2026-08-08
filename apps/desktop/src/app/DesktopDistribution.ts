import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const DesktopDistributionId = Schema.Literals(["default", "2code-production"]);
export type DesktopDistributionId = typeof DesktopDistributionId.Type;

const EmbeddedDesktopDistributionMetadata = Schema.Struct({
  t3codeDistribution: Schema.optional(Schema.Literal("2code-production")),
  t3codeRuntimeVersion: Schema.optional(Schema.String),
});

export interface DesktopDistributionMetadata {
  readonly id: DesktopDistributionId;
  readonly runtimeVersion: string;
}

const decodeEmbeddedDesktopDistributionMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EmbeddedDesktopDistributionMetadata),
);

export class DesktopDistributionMetadataError extends Schema.TaggedErrorClass<DesktopDistributionMetadataError>()(
  "DesktopDistributionMetadataError",
  {
    operation: Schema.Literals(["read", "decode"]),
    packageJsonPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} embedded desktop distribution metadata at "${this.packageJsonPath}".`;
  }
}

/**
 * Resolve fork distribution metadata before any state path is selected. Packaged
 * 2code builds must identify themselves in their staged package.json; ordinary
 * T3 and every development build remain on the default distribution.
 */
export const resolveDesktopDistribution = Effect.fn("desktop.distribution.resolve")(
  function* (input: {
    readonly appPath: string;
    readonly appVersion: string;
    readonly isPackaged: boolean;
  }): Effect.fn.Return<
    DesktopDistributionMetadata,
    DesktopDistributionMetadataError,
    FileSystem.FileSystem | Path.Path
  > {
    if (!input.isPackaged) {
      return { id: "default", runtimeVersion: input.appVersion };
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageJsonPath = path.join(input.appPath, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopDistributionMetadataError({
            operation: "read",
            packageJsonPath,
            cause,
          }),
      ),
    );
    const metadata = yield* decodeEmbeddedDesktopDistributionMetadata(raw).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopDistributionMetadataError({
            operation: "decode",
            packageJsonPath,
            cause,
          }),
      ),
    );
    const id = metadata.t3codeDistribution ?? "default";
    const embeddedRuntimeVersion = metadata.t3codeRuntimeVersion?.trim();
    if (id === "2code-production" && !embeddedRuntimeVersion) {
      return yield* new DesktopDistributionMetadataError({
        operation: "decode",
        packageJsonPath,
        cause: new Error("2code-production requires t3codeRuntimeVersion."),
      });
    }
    return {
      id,
      runtimeVersion: embeddedRuntimeVersion || input.appVersion,
    };
  },
);
