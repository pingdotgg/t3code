// @effect-diagnostics preferSchemaOverJson:off
// shared fixtures for serverSettings (never imports the test file)
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  type ManagedPolicyDocument,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  SecretProviderId,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SchemaAST from "effect/SchemaAST";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { sourceControlHostSecretName } from "./sourceControl/sourceControlHostSecrets.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerSettingsModule from "./serverSettings.ts";
import { SECRET_REDACTED } from "./settingsSecrets.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

export const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

export const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

export const decodeServerSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);


export const layerServerSettings = (policy?: ManagedPolicyDocument) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );


export const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );


export const layerFailingSecretStore = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );


export const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });


export function strictSecretReferencePaths(
  ast: SchemaAST.AST,
  path = "",
  seen = new Set<SchemaAST.AST>(),
): ReadonlyArray<string> {
  if (seen.has(ast)) return [];
  seen.add(ast);
  const walk = (type: SchemaAST.AST, at: string): ReadonlyArray<string> =>
    type.context?.annotations?.settingsSecretReference === true
      ? [at]
      : strictSecretReferencePaths(type, `${at}.`, seen);
  if (SchemaAST.isObjects(ast)) {
    return [
      ...ast.propertySignatures.flatMap((property) =>
        walk(property.type, `${path}${String(property.name)}`),
      ),
      ...ast.indexSignatures.flatMap((signature) => walk(signature.type, `${path}*`)),
    ];
  }
  if (SchemaAST.isArrays(ast)) {
    return [...ast.elements, ...ast.rest].flatMap((element) => walk(element, `${path}[]`));
  }
  if (SchemaAST.isUnion(ast)) {
    return ast.types.flatMap((member) => strictSecretReferencePaths(member, path, seen));
  }
  if (SchemaAST.isSuspend(ast)) return strictSecretReferencePaths(ast.thunk(), path, seen);
  return [];
}
