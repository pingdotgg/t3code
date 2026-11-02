import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DelegatedSandbox = Schema.Union([
  Schema.Struct({ type: Schema.Literal("readOnly"), networkAccess: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("workspaceWrite"),
    networkAccess: Schema.Boolean,
    writableRoots: Schema.Array(Schema.String),
    excludeSlashTmp: Schema.Boolean,
    excludeTmpdirEnvVar: Schema.Boolean,
  }),
]);
export type DelegatedSandbox = typeof DelegatedSandbox.Type;

export const DelegatedExecution = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: Schema.String,
  sandboxPolicy: DelegatedSandbox,
});
export type DelegatedExecution = typeof DelegatedExecution.Type;
