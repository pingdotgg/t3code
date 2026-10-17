// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);

// The SDK omits RequestedModel.maxMode and exposes no way to set it. Cursor's
// current context tiers above 300K require Max Mode, as in its CLI. Patch only
// that message in the SDK's own disk-backed protobuf runtime, before loading
// the SDK. Remove this workaround when ModelSelection supports Max Mode.
// https://github.com/pingdotgg/t3code/issues/15788
const requireCursorSdkDependency = NodeModule.createRequire(
  requireCursorSdk.resolve("@cursor/sdk"),
);
const { proto3 } = requireCursorSdkDependency("@bufbuild/protobuf") as {
  proto3: {
    util: {
      initPartial: (
        source: unknown,
        target: {
          getType: () => { typeName: string };
          maxMode?: boolean;
          parameters?: ReadonlyArray<{ id: string; value: string }>;
        },
      ) => void;
    };
  };
};
const initPartial = proto3.util.initPartial;
proto3.util.initPartial = function (source, target) {
  initPartial.call(this, source, target);
  if (target.getType().typeName !== "agent.v1.RequestedModel" || target.maxMode) {
    return;
  }
  const context = target.parameters?.find((parameter) => parameter.id === "context")?.value ?? "";
  const tier = /^(\d+(?:\.\d+)?)([km])$/i.exec(context);
  if (tier && Number(tier[1]) * (tier[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000) > 300_000) {
    target.maxMode = true;
  }
};

export const {
  Agent,
  AuthenticationError,
  createAgentPlatform,
  Cursor,
  CursorSdkError,
  InMemoryCredentialStore,
} = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
export const { SqliteLocalAgentStore } = requireCursorSdk(
  "@cursor/sdk/sqlite",
) as typeof import("@cursor/sdk/sqlite");
