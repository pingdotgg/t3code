import { Effect, Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AcpDistributionType = Schema.Literals([
  "manual",
  "npx",
  "uvx",
  "binary",
  "binaryUnsupported",
]);
export type AcpDistributionType = typeof AcpDistributionType.Type;

export const AcpLaunchSpec = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AcpLaunchSpec = typeof AcpLaunchSpec.Type;

export const AcpRegistryAgent = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  repository: Schema.optional(TrimmedNonEmptyString),
  website: Schema.optional(TrimmedNonEmptyString),
  authors: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  license: Schema.optional(TrimmedNonEmptyString),
  icon: Schema.optional(TrimmedNonEmptyString),
  distribution: Schema.Struct({
    npx: Schema.optional(
      Schema.Struct({
        package: TrimmedNonEmptyString,
        args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
        env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
    uvx: Schema.optional(
      Schema.Struct({
        package: TrimmedNonEmptyString,
        args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
        env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
    binary: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
export type AcpRegistryAgent = typeof AcpRegistryAgent.Type;

export const AcpRegistryIndex = Schema.Struct({
  version: TrimmedNonEmptyString,
  agents: Schema.Array(AcpRegistryAgent),
});
export type AcpRegistryIndex = typeof AcpRegistryIndex.Type;

export const ResolvedRegistryAcpAgent = Schema.Struct({
  agent: AcpRegistryAgent,
  supported: Schema.Boolean,
  distributionType: AcpDistributionType,
  launch: Schema.NullOr(AcpLaunchSpec),
  binaryInstall: Schema.optional(
    Schema.Struct({
      archiveUrl: TrimmedNonEmptyString,
      defaultInstallPath: TrimmedNonEmptyString,
      platformKey: TrimmedNonEmptyString,
      command: TrimmedNonEmptyString,
    }),
  ),
});
export type ResolvedRegistryAcpAgent = typeof ResolvedRegistryAcpAgent.Type;

export const AcpRegistryListResult = Schema.Struct({
  registryVersion: TrimmedNonEmptyString,
  agents: Schema.Array(ResolvedRegistryAcpAgent),
});
export type AcpRegistryListResult = typeof AcpRegistryListResult.Type;

export const AcpRegistryInstallBinaryInput = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  installPath: Schema.optional(TrimmedNonEmptyString),
});
export type AcpRegistryInstallBinaryInput = typeof AcpRegistryInstallBinaryInput.Type;

export const AcpRegistryInstallBinaryResult = Schema.Struct({
  ok: Schema.Boolean,
  agent: Schema.optional(ResolvedRegistryAcpAgent),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type AcpRegistryInstallBinaryResult = typeof AcpRegistryInstallBinaryResult.Type;

export const ServerAcpAgentStatus = Schema.Struct({
  agentServerId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: Schema.Literals(["ready", "warning", "error", "disabled"]),
  authStatus: Schema.Literals(["authenticated", "unauthenticated", "unknown"]),
  checkedAt: IsoDateTime,
  displayName: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  version: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerAcpAgentStatus = typeof ServerAcpAgentStatus.Type;
