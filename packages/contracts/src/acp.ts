import { Effect, Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AcpAgentServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type AcpAgentServerId = typeof AcpAgentServerId.Type;

export const AcpDistributionType = Schema.Literals(["manual", "npx", "uvx", "binaryUnsupported"]);
export type AcpDistributionType = typeof AcpDistributionType.Type;

export const AcpAgentSource = Schema.Literals(["manual", "registry"]);
export type AcpAgentSource = typeof AcpAgentSource.Type;

export const AcpLaunchSpec = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AcpLaunchSpec = typeof AcpLaunchSpec.Type;

export const AcpAgentServer = Schema.Struct({
  id: AcpAgentServerId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  source: AcpAgentSource,
  distributionType: AcpDistributionType,
  launch: AcpLaunchSpec,
  description: Schema.optional(TrimmedNonEmptyString),
  website: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(TrimmedNonEmptyString),
  iconUrl: Schema.optional(TrimmedNonEmptyString),
  registryAgentId: Schema.optional(TrimmedNonEmptyString),
  importedVersion: Schema.optional(TrimmedNonEmptyString),
});
export type AcpAgentServer = typeof AcpAgentServer.Type;

export const ServerAcpAgentStatus = Schema.Struct({
  agentServerId: AcpAgentServerId,
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

const AcpRegistryBinaryDistribution = Schema.Record(
  Schema.String,
  Schema.Struct({
    archive: TrimmedNonEmptyString,
    cmd: TrimmedNonEmptyString,
    args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
);

export const AcpRegistryAgent = Schema.Struct({
  id: AcpAgentServerId,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  repository: Schema.optional(TrimmedNonEmptyString),
  website: Schema.optional(TrimmedNonEmptyString),
  authors: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  license: Schema.optional(TrimmedNonEmptyString),
  icon: Schema.optional(TrimmedNonEmptyString),
  distribution: Schema.Struct({
    binary: Schema.optional(AcpRegistryBinaryDistribution),
    npx: Schema.optional(
      Schema.Struct({
        package: TrimmedNonEmptyString,
        args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      }),
    ),
    uvx: Schema.optional(
      Schema.Struct({
        package: TrimmedNonEmptyString,
        args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      }),
    ),
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
});
export type ResolvedRegistryAcpAgent = typeof ResolvedRegistryAcpAgent.Type;

export const AcpRegistryListResult = Schema.Struct({
  registryVersion: TrimmedNonEmptyString,
  agents: Schema.Array(ResolvedRegistryAcpAgent),
});
export type AcpRegistryListResult = typeof AcpRegistryListResult.Type;
