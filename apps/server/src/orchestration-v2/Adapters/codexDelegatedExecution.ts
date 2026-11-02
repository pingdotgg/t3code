import {
  DelegatedSandbox,
  type DelegatedExecution,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.String,
    activePermissionProfile: Schema.optional(Schema.NullOr(Schema.Unknown)),
    sandboxPolicy: Schema.Unknown,
  }),
);

const decodeSandbox = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("readOnly"),
      networkAccess: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("workspaceWrite"),
      networkAccess: Schema.optional(Schema.Boolean),
      writableRoots: Schema.optional(Schema.Array(Schema.String)),
      excludeSlashTmp: Schema.optional(Schema.Boolean),
      excludeTmpdirEnvVar: Schema.optional(Schema.Boolean),
    }),
  ]),
);

export function captureDelegatedExecution(
  providerInstanceId: ProviderInstanceId,
  settings: unknown,
  isAbsolute: (path: string) => boolean,
): DelegatedExecution | undefined {
  const decoded = decodeSettings(settings);
  if (decoded._tag === "None") return undefined;
  const value = decoded.value;
  // A legacy sandbox cannot reproduce a custom profile's filesystem deny rules.
  if (value.activePermissionProfile != null || !isAbsolute(value.cwd)) return undefined;
  const sandbox = decodeSandbox(value.sandboxPolicy);
  if (sandbox._tag === "None") return undefined;
  const policy = sandbox.value;
  if (policy.type === "readOnly") {
    if (policy.networkAccess === true) return undefined;
    return {
      providerInstanceId,
      cwd: value.cwd,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
  }
  if (policy.writableRoots?.some((root) => !isAbsolute(root))) return undefined;
  return {
    providerInstanceId,
    cwd: value.cwd,
    sandboxPolicy: DelegatedSandbox.make({
      type: "workspaceWrite",
      networkAccess: policy.networkAccess ?? false,
      writableRoots: policy.writableRoots ?? [],
      excludeSlashTmp: policy.excludeSlashTmp ?? false,
      excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar ?? false,
    }),
  };
}

export function withinDelegatedExecution(
  current: DelegatedExecution,
  ceiling: DelegatedExecution,
): boolean {
  if (current.providerInstanceId !== ceiling.providerInstanceId || current.cwd !== ceiling.cwd)
    return false;
  const policy = current.sandboxPolicy;
  const limit = ceiling.sandboxPolicy;
  if (policy.networkAccess && !limit.networkAccess) return false;
  if (policy.type === "readOnly") return true;
  if (limit.type !== "workspaceWrite") return false;
  return (
    (!limit.excludeSlashTmp || policy.excludeSlashTmp) &&
    (!limit.excludeTmpdirEnvVar || policy.excludeTmpdirEnvVar) &&
    policy.writableRoots.every((root) => limit.writableRoots.includes(root))
  );
}
