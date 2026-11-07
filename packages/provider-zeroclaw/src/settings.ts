// Shared with the client settings form; keep schema code browser-safe.
import { CustomModelSetting, makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ZeroClawSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    socketPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Daemon socket",
        description:
          "Path to the ZeroClaw daemon socket. Empty uses ZEROCLAW_SOCKET, then the default data directory.",
        providerSettingsForm: {
          placeholder: "/home/me/.zeroclaw/data/daemon.sock",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    defaultAgentAlias: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Default agent",
        description: "Agent alias used when a thread does not select one.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["socketPath", "defaultAgentAlias"],
  },
);
export type ZeroClawSettings = typeof ZeroClawSettings.Type;
