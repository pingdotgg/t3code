import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

import { DesktopSshEnvironmentTargetSchema } from "./ssh.ts";
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "./providerInstance.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";
import { SecretReference } from "./secretReference.ts";

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const State = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
/** Sign-in flows CLIProxyAPI serves at `/v0/management/<id>-auth-url`. */
export const INFERENCE_UPSTREAMS = {
  anthropic: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  xai: "xAI",
  kimi: "Kimi (kimi.com)",
  "kimi-ai": "Kimi (kimi.ai)",
  meta: "Meta AI",
  devin: "Devin",
} as const;
export type InferenceUpstream = keyof typeof INFERENCE_UPSTREAMS;
const upstreams = Object.keys(INFERENCE_UPSTREAMS) as ReadonlyArray<InferenceUpstream>;
export const InferenceUpstream = Schema.Literals(upstreams);

interface InferenceHarness {
  readonly label: string;
  /** Sign-in flows that add an account this harness can use. */
  readonly upstreams: ReadonlyArray<InferenceUpstream>;
  /** Proxy account kinds this harness can use; null means every kind. */
  readonly accounts: ReadonlyArray<string> | null;
  /** True when the pool replaces the harness's own logins. T3 then hides its other instances. */
  readonly replacesAccounts: boolean;
}
const harnesses = {
  codex: { label: "Codex", upstreams: ["codex"], accounts: ["codex"], replacesAccounts: true },
  claudeAgent: {
    label: "Claude",
    upstreams: ["anthropic"],
    accounts: ["claude"],
    replacesAccounts: true,
  },
  opencode: { label: "OpenCode", upstreams, accounts: null, replacesAccounts: false },
  pi: { label: "Pi", upstreams, accounts: null, replacesAccounts: false },
} satisfies Record<string, InferenceHarness>;
/** Harnesses that can run on pooled accounts. */
export type InferenceDriver = keyof typeof harnesses;
export const INFERENCE_HARNESSES: Readonly<Record<InferenceDriver, InferenceHarness>> = harnesses;
export const INFERENCE_DRIVERS = Object.keys(harnesses) as ReadonlyArray<InferenceDriver>;
export const InferenceDriver = Schema.Literals(INFERENCE_DRIVERS);
export const InferenceRouteHealth = Schema.Struct({
  availableDrivers: Schema.Array(InferenceDriver),
  models: Schema.Array(Schema.String),
});
export type InferenceRouteHealth = typeof InferenceRouteHealth.Type;

const isInferenceDriver = Schema.is(InferenceDriver);
export const inferenceHarness = (driver: string): InferenceHarness | undefined =>
  isInferenceDriver(driver) ? INFERENCE_HARNESSES[driver] : undefined;

export const InferenceConsumer = Schema.Struct({ environmentId: EnvironmentId, label: Label });
export type InferenceConsumer = typeof InferenceConsumer.Type;

export const InferenceGrantInput = Schema.Struct({
  ...InferenceConsumer.fields,
  automatic: Schema.optionalKey(Schema.Boolean),
});
export type InferenceGrantInput = typeof InferenceGrantInput.Type;

const Strategy = Schema.Literals(["round-robin", "fill-first"]);
export const InferenceRouting = Schema.Struct({
  strategy: Strategy,
  sessionAffinity: Schema.Boolean,
});
export type InferenceRouting = typeof InferenceRouting.Type;
export const defaultInferenceRouting: InferenceRouting = {
  strategy: "fill-first",
  sessionAffinity: true,
};

export const InferenceProxyStatus = Schema.Struct({
  enabled: Schema.Boolean,
  sharing: Schema.Boolean,
  running: Schema.Boolean,
  version: Schema.String,
  routing: Schema.optionalKey(InferenceRouting),
  problem: Schema.NullOr(Schema.String),
  accounts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      provider: Schema.String,
      status: Schema.String,
      availability: Schema.optionalKey(
        Schema.Literals([
          "available",
          "authenticationError",
          "rateLimited",
          "unavailable",
          "disabled",
        ]),
      ),
      retryAfter: Schema.optionalKey(Schema.String),
    }),
  ),
  availableDrivers: Schema.optionalKey(Schema.Array(InferenceDriver)),
  consumers: Schema.Array(InferenceConsumer),
  routes: Schema.Array(Schema.Struct({ instanceId: ProviderInstanceId, label: Schema.String })),
});
export type InferenceProxyStatus = typeof InferenceProxyStatus.Type;

export function inferenceRouteIssue(host: InferenceProxyStatus | null, local: boolean) {
  if (!host) return "Host status unavailable.";
  if (!host.enabled) return "Enable inference hosting on this environment first.";
  if (!host.running) return host.problem ?? "The inference host is stopped.";
  if (!local && !host.sharing) return "Enable sharing on the host first.";
  if (!host.accounts.length && !host.availableDrivers?.length)
    return "Add a provider account on the host first.";
  if (host.availableDrivers?.length === 0) return "All hosted accounts are unavailable.";
  if (
    host.availableDrivers === undefined &&
    !host.accounts.some(
      (account) =>
        account.availability === "available" ||
        (account.availability === undefined && account.status === "active"),
    )
  )
    return "All hosted accounts are unavailable.";
  return null;
}

export const InferenceProxyAction = Schema.Union([
  Schema.Struct({ operation: Schema.Literals(["checkUpdate", "update"]) }),
  Schema.Struct({
    operation: Schema.Literal("setRouting"),
    strategy: Schema.optionalKey(Strategy),
    sessionAffinity: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    operation: Schema.Literal("configure"),
    enabled: Schema.Boolean,
    sharing: Schema.Boolean,
  }),
  Schema.Struct({ operation: Schema.Literal("signIn"), upstream: InferenceUpstream }),
  Schema.Struct({
    operation: Schema.Literal("callback"),
    state: State,
    callback: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
  }),
  Schema.Struct({ operation: Schema.Literal("check"), state: State }),
  Schema.Struct({ operation: Schema.Literal("cancel"), state: State }),
  Schema.Struct({ operation: Schema.Literal("removeAccount"), name: Label }),
  Schema.Struct({ operation: Schema.Literal("removeRoute"), instanceId: ProviderInstanceId }),
  Schema.Struct({ operation: Schema.Literal("revoke"), environmentId: EnvironmentId }),
]);
export type InferenceProxyAction = typeof InferenceProxyAction.Type;
export const InferenceProxyActionResult = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  update: Schema.optionalKey(
    Schema.Struct({ current: Schema.String, available: Schema.NullOr(Schema.String) }),
  ),
  login: Schema.optionalKey(Schema.Struct({ url: Schema.String, state: State })),
  status: Schema.optionalKey(Schema.Literals(["wait", "ok", "error"])),
});
export type InferenceProxyActionResult = typeof InferenceProxyActionResult.Type;

export const InferenceRouteGrant = Schema.Struct({
  hostId: EnvironmentId,
  consumerId: EnvironmentId,
  baseUrl: Schema.String,
  alternates: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(32))),
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type InferenceRouteGrant = typeof InferenceRouteGrant.Type;
export const InferenceHostConnection = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  ssh: Schema.optionalKey(DesktopSshEnvironmentTargetSchema),
});
export type InferenceHostConnection = typeof InferenceHostConnection.Type;
export const InferenceProviderConfig = Schema.Struct({
  inferenceEnabled: Schema.Boolean,
  inferenceHostId: EnvironmentId,
  inferenceHostLabel: Schema.String,
  inferenceBaseUrl: Schema.String,
  inferenceKey: Schema.Union([TrimmedNonEmptyString, SecretReference]),
  inferenceModels: Schema.Array(Schema.String),
  inferenceHomePath: Schema.String,
  inferenceConnection: Schema.optionalKey(InferenceHostConnection),
});
export type InferenceProviderConfig = typeof InferenceProviderConfig.Type;
export const isInferenceProviderConfig = Schema.is(InferenceProviderConfig);
export const isInferenceRoutingEnabled = Schema.is(
  Schema.Struct({ inferenceEnabled: Schema.Literal(true) }),
);
export const InferenceProviderFields = {
  inferenceEnabled: Schema.optionalKey(Schema.Boolean).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
  inferenceHostId: Schema.optionalKey(EnvironmentId).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
  inferenceHostLabel: Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
  inferenceBaseUrl: Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
  inferenceKey: Schema.optionalKey(SettingsSecretValue).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
  inferenceModels: Schema.optionalKey(Schema.Array(Schema.String)).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
  inferenceHomePath: Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
  inferenceConnection: Schema.optionalKey(InferenceHostConnection).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true }, settingsMachineLocal: true }),
  ),
};
const hasLaunchArgs = Schema.is(Schema.Struct({ launchArgs: Schema.optionalKey(Schema.String) }));
const hasServerUrl = Schema.is(Schema.Struct({ serverUrl: Schema.NonEmptyString }));
export const isCustomInferenceBackend = (instance: ProviderInstanceConfig) =>
  !isInferenceRoutingEnabled(instance.config) &&
  ((instance.driver === "codex" &&
    hasLaunchArgs(instance.config) &&
    /model_provider\s*=/.test(instance.config.launchArgs ?? "")) ||
    // T3 does not start an external OpenCode server, so it cannot hand it the pooled provider.
    (instance.driver === "opencode" && hasServerUrl(instance.config)) ||
    (instance.driver === "claudeAgent" &&
      instance.environment?.some(
        (entry) => entry.name === "ANTHROPIC_BASE_URL" && entry.value !== "",
      )));

export function isInferenceAccountReplaced(
  instanceId: ProviderInstanceId,
  instances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>,
): boolean {
  const instance = Object.hasOwn(instances, instanceId) ? instances[instanceId] : undefined;
  if (!instance || !inferenceHarness(instance.driver)?.replacesAccounts) return false;
  const defaultId = defaultInstanceIdForDriver(instance.driver);
  return (
    instanceId !== defaultId &&
    isInferenceRoutingEnabled(instances[defaultId]?.config) &&
    !isCustomInferenceBackend(instance)
  );
}

export const InferenceRouteInput = Schema.Struct({
  grant: InferenceRouteGrant,
  driver: InferenceDriver,
  hostLabel: Label,
  connection: Schema.optionalKey(InferenceHostConnection),
});
export type InferenceRouteInput = typeof InferenceRouteInput.Type;
export class InferenceProxyError extends Schema.TaggedError<InferenceProxyError>()(
  "InferenceProxyError",
  {
    message: Schema.String,
  },
) {}
