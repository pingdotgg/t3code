import { OpenShellSandboxTemplate, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { OpenShellClient } from "@nvidia/openshell-sdk";
import type {
  ConnectOptions,
  OidcTokenProvider,
  SandboxRef,
  SandboxWorkloadTemplate,
} from "@nvidia/openshell-sdk";
import { DeletionOutcome as WireDeletionOutcome, SandboxPhase } from "@nvidia/openshell-sdk/raw";
import type { DeletionOutcome as WireDeletionOutcomeType } from "@nvidia/openshell-sdk/raw";
import type { Sandbox as WireSandbox } from "@nvidia/openshell-sdk/raw";
import { NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import type { OpenShellWorkerSandboxPolicy } from "./sandboxPolicy.ts";

/** Fleet labels every worker sandbox carries (spec sections 4.4 and 5.6). */
export const FLEET_ROLE_LABEL = "t3-role";
export const MANAGED_BY_LABEL = "t3-managed-by";
export const WORKER_CLASS_LABEL = "t3-worker-class";
export const TEMPLATE_ROLE_LABEL = "t3-template-role";

/**
 * Pairing material is read from the worker over gateway exec; the t3-agent
 * image entrypoint prints it (spec section 4.4 step 4c). OPEN (lane 1, spec
 * section 9.2): the exact command is fixed with the t3-agent image in P1.
 */
export const PAIRING_INFO_COMMAND: ReadonlyArray<string> = ["t3", "pairing", "print"];

/** What a ready worker reports over gateway exec so it can be paired. */
export interface WorkerPairingMaterial {
  /** The worker's own t3 environment id (anti-impersonation anchor). */
  readonly environmentId: string;
  /** Where the worker's /mcp answers (the managing instance dials this). */
  readonly url: string;
  /** One-time bootstrap credential, exchanged for a delegation session. */
  readonly bootstrapCredential: string;
}

const PairingMaterialSchema = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  bootstrapCredential: TrimmedNonEmptyString,
});

const decodePairingMaterial = Schema.decodeUnknownSync(PairingMaterialSchema);

/** Parses the exec output; throws when the worker did not answer as expected. */
export const parseWorkerPairingMaterial = (stdout: string): WorkerPairingMaterial => {
  try {
    return decodePairingMaterial(JSON.parse(stdout));
  } catch (cause) {
    throw new Error(
      "The worker did not report valid pairing material over gateway exec (spec section 4.4).",
      { cause },
    );
  }
};

/** A sandbox as the driver sees it through the gateway client. */
export interface OpenShellSandboxView {
  readonly name: string;
  readonly sandboxId: string;
  /** Gateway lifecycle phase, e.g. `Ready` (lane 1, sandbox lifecycle table). */
  readonly phase: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Epoch ms when the gateway created it, for orphan-sweep grace (spec section 5.6.1). */
  readonly createdAt: number | null;
}

export interface OpenShellExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Inline-resource mount for a template's shared volumes (spec sections 8.1 and 9.1). */
export interface OpenShellTemplateMount {
  /** Volume name inside the driver config. */
  readonly name: string;
  /** Operator-labeled, admission-approved PVC (lane 1, external resource admission). */
  readonly pvc: string;
  readonly mountPath: string;
  readonly readOnly?: boolean;
}

export interface OpenShellTemplateCreateSpec {
  readonly name: string;
  readonly image?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly cpu?: string;
  readonly memory?: string;
  readonly gpu?: number;
  /** Shared RWX mounts, mapped to `driver_config.kubernetes` (spec section 9.1). */
  readonly mounts?: ReadonlyArray<OpenShellTemplateMount>;
  /** Fleet role label for the desktop template picker (spec section 4.4). */
  readonly role?: "managing" | "worker";
}

export interface OpenShellSandboxCreateSpec {
  readonly template: string;
  /** Deterministic sandbox name, e.g. `t3-worker-<hash>` (spec section 5.4). */
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** Durable admission request id: retries converge on the same object (lane 1). */
  readonly requestId?: string;
  /** OPEN (SDK 0.1.7): per-sandbox environment overrides cannot accompany a template. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Runtime policy supplied with creation: static filesystem fields cannot change later. */
  readonly policy?: OpenShellWorkerSandboxPolicy;
}

/**
 * SDK 0.1.7 rejects `spec.environment` when a workload template is set, but
 * its curated create seam also lacks durable request ids. Refuse the seed here
 * rather than sending a request the gateway will reject after admission.
 */
export const unsupportedCreateEnvironmentReason = (
  environment: Readonly<Record<string, string>> | undefined,
): string | undefined =>
  environment === undefined || Object.keys(environment).length === 0
    ? undefined
    : "SDK 0.1.7 cannot deliver per-sandbox environment overrides with a workload template; no sandbox was created.";

/** OpenShell's default-deny network model has no compact whole-internet rule. */
export const unsupportedOpenShellPolicyReason = (
  policy: OpenShellWorkerSandboxPolicy | undefined,
): string | undefined =>
  policy?.type === "dangerFullAccess"
    ? "The OpenShell gateway cannot express dangerFullAccess as a bounded policy; no sandbox was created."
    : undefined;

const WIRE_POLICY_READ_PATHS = [
  "/bin",
  "/usr",
  "/lib",
  "/proc",
  "/dev/urandom",
  "/etc",
  "/var/log",
];

/**
 * T3 policy → SDK 0.1.7 wire policy. Network endpoints are L4-only and apply to
 * every process; the workspace and standard runtime paths are filesystem bounds.
 */
export const openShellWirePolicy = (
  policy: OpenShellWorkerSandboxPolicy,
): Record<string, unknown> => ({
  version: 1,
  filesystemPolicy: {
    includeWorkdir: false,
    readOnly: [...WIRE_POLICY_READ_PATHS],
    readWrite:
      policy.type === "workspaceWrite"
        ? [...(policy.writableRoots ?? []), "/tmp", "/dev/null"]
        : ["/tmp", "/dev/null"],
  },
  landlock: { compatibility: "best_effort" },
  networkPolicies:
    policy.network.mode === "default-deny"
      ? {}
      : Object.fromEntries(
          policy.network.allowedDomains.map((host, index) => [
            `allow-${index}`,
            {
              name: host,
              endpoints: [
                {
                  host,
                  ports: [80, 443],
                  protocol: "tcp",
                  tls: NetworkTlsMode.UNSPECIFIED,
                },
              ],
              binaries: [{ path: "/**" }],
            },
          ]),
        ),
});

/**
 * Structural mirror of the OpenShell TypeScript SDK surface the driver needs
 * (lane 1: `client.sandbox` and `client.sandboxTemplates()`). The gateway
 * client below maps it; unit tests inject fakes, so no network is involved.
 */
export interface OpenShellGatewayClient {
  readonly health: () => Promise<void>;
  readonly createFromTemplate: (spec: OpenShellSandboxCreateSpec) => Promise<OpenShellSandboxView>;
  /** `null` only when the gateway confirms no such sandbox; other failures throw. */
  readonly get: (name: string) => Promise<OpenShellSandboxView | null>;
  readonly listAll: (selector?: {
    labels?: Readonly<Record<string, string>>;
  }) => Promise<ReadonlyArray<OpenShellSandboxView>>;
  readonly deleteSandbox: (
    name: string,
    options?: { requestId?: string },
  ) => Promise<"completed" | "accepted" | "already_absent">;
  /** Polls until the sandbox phase is Ready or the deadline passes (client.ts:1347). */
  readonly waitReady: (name: string, timeoutSecs: number) => Promise<OpenShellSandboxView>;
  readonly exec: (name: string, command: ReadonlyArray<string>) => Promise<OpenShellExecResult>;
  readonly listTemplates: () => Promise<ReadonlyArray<OpenShellSandboxTemplate>>;
  readonly createTemplate: (spec: OpenShellTemplateCreateSpec) => Promise<OpenShellSandboxTemplate>;
}

export interface ConnectOpenShellGatewayOptions {
  readonly gatewayUrl: string;
  /**
   * Promise-shaped token provider. The adapter wraps it in the SDK's
   * `{ getToken(signal?) }` seam (SDK 0.1.7).
   */
  readonly oidcTokenProvider?: () => Promise<string>;
  /**
   * PEM-encoded mTLS transport material (`caCert + clientCert + clientKey`).
   * Strings are accepted at this seam and converted to the SDK's `Buffer`
   * fields at connect time.
   */
  readonly caCert?: string;
  readonly clientCert?: string;
  readonly clientKey?: string;
}

const PHASE_NAMES = [
  "unspecified",
  "provisioning",
  "ready",
  "error",
  "deleting",
  "unknown",
  "stopping",
  "stopped",
  "starting",
  "completed",
  "suspending",
  "suspended",
] as const;

const wirePhaseName = (phase: number): string => PHASE_NAMES[phase] ?? "unknown";

const toSandboxView = (sandbox: SandboxRef): OpenShellSandboxView => ({
  name: sandbox.name,
  sandboxId: sandbox.id,
  phase: sandbox.phase,
  labels: sandbox.labels,
  createdAt: sandbox.createdAtMs ?? null,
});

const toWireSandboxView = (sandbox: WireSandbox): OpenShellSandboxView => {
  const name = sandbox.metadata?.name ?? "";
  if (name === "") throw new Error("The gateway returned a sandbox without a name.");
  return {
    name,
    sandboxId: sandbox.metadata?.id ?? name,
    phase: wirePhaseName(sandbox.status?.phase ?? SandboxPhase.UNSPECIFIED),
    labels: sandbox.metadata?.labels ?? {},
    createdAt: sandbox.metadata?.createdTime
      ? Number(sandbox.metadata.createdTime.seconds) * 1000
      : null,
  };
};

/**
 * Only the gateway's confirmed "no such sandbox" answers count as absence. A
 * transport failure must not read as an absent sandbox, or a caller could
 * delete a sandbox it never actually saw.
 */
export const isSandboxNotFoundError = (cause: unknown): boolean => {
  const nullish = cause as { status?: unknown; statusCode?: unknown; code?: unknown } | null;
  if (nullish === null || nullish === undefined) return false;
  const code = typeof nullish.code === "string" ? nullish.code.toLowerCase() : undefined;
  // A structured SDK code is authoritative: e.g. `[rpc] upstream route not
  // found` must not turn an unavailable gateway into an absent sandbox.
  if (code !== undefined) return code === "not_found";
  if (nullish.status === 404 || nullish.statusCode === 404) return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b404\b|not found/i.test(message);
};

/** Fleet operations live in the SDK's required default workspace. */
const DEFAULT_WORKSPACE_SCOPE = {
  selection: { case: "workspace", value: "default" },
} as const;

const templateFromUnknown = Schema.decodeUnknownSync(OpenShellSandboxTemplate);

/**
 * Normalizes deletion answers to the contracts' typed outcomes. The curated
 * fake seam accepts older string/object shapes; the real SDK path gets the
 * generated numeric enum and uses {@link parseWireDeleteOutcome}.
 */
export const parseDeleteOutcome = (
  result: unknown,
): "completed" | "accepted" | "already_absent" => {
  const raw =
    typeof result === "string"
      ? result
      : ((result as { outcome?: unknown }).outcome ?? (result as { status?: unknown }).status);
  if (typeof raw !== "string") {
    throw new Error(
      `The gateway returned an unreadable deletion outcome: ${JSON.stringify(result)}`,
    );
  }
  const normalized = raw.toLowerCase();
  if (normalized !== "completed" && normalized !== "accepted" && normalized !== "already_absent") {
    throw new Error(`The gateway returned an unknown deletion outcome: ${raw}`);
  }
  return normalized;
};

/** Turns SDK 0.1.7's generated deletion enum into the contracts' outcome. */
export const parseWireDeleteOutcome = (outcome: WireDeletionOutcomeType) => {
  switch (outcome) {
    case WireDeletionOutcome.COMPLETED:
      return "completed";
    case WireDeletionOutcome.ACCEPTED:
      return "accepted";
    case WireDeletionOutcome.ALREADY_ABSENT:
      return "already_absent";
    default:
      throw new Error(`The gateway returned an unreadable deletion outcome: ${outcome}`);
  }
};

const toLabelSelector = (labels: Readonly<Record<string, string>>): string =>
  Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

const pem = (value: string) => Buffer.from(value, "utf8");

const tokenProvider = (provider: (() => Promise<string>) | undefined): OidcTokenProvider => ({
  getToken: () => (provider === undefined ? Promise.resolve("") : provider()),
});

const connectOptions = (options: ConnectOpenShellGatewayOptions): ConnectOptions => {
  const sdkOptions: ConnectOptions = { gateway: options.gatewayUrl };
  if (options.oidcTokenProvider !== undefined) {
    sdkOptions.oidcTokenProvider = tokenProvider(options.oidcTokenProvider);
  }
  if (options.caCert !== undefined) sdkOptions.caCert = pem(options.caCert);
  if (options.clientCert !== undefined) sdkOptions.clientCert = pem(options.clientCert);
  if (options.clientKey !== undefined) sdkOptions.clientKey = pem(options.clientKey);
  return sdkOptions;
};

const toTemplateView = (template: SandboxWorkloadTemplate): OpenShellSandboxTemplate => {
  const workload = template.spec?.workload;
  const resources = workload?.resources;
  const role = template.metadata?.labels?.[TEMPLATE_ROLE_LABEL];
  return templateFromUnknown({
    name: template.metadata?.name ?? "",
    ...(workload?.image === undefined || workload.image === "" ? {} : { image: workload.image }),
    ...(resources?.cpu === undefined || resources.cpu === "" ? {} : { cpu: resources.cpu }),
    ...(resources?.memory === undefined || resources.memory === ""
      ? {}
      : { memory: resources.memory }),
    ...(role === "managing" || role === "worker" ? { role } : {}),
  });
};

/**
 * Connects the real SDK and adapts it to {@link OpenShellGatewayClient}. The
 * delete outcome is lowercased to the contracts' typed values.
 */
export const connectOpenShellGateway = async (
  options: ConnectOpenShellGatewayOptions,
): Promise<OpenShellGatewayClient> => {
  const client = await OpenShellClient.connect(connectOptions(options));
  return {
    health: async () => {
      await client.health();
    },
    createFromTemplate: async (spec) => {
      // The curated SDK seam does not expose request ids or per-sandbox env
      // overrides in 0.1.7, so create uses the SDK's raw RPC escape hatch.
      const unsupportedEnvironment = unsupportedCreateEnvironmentReason(spec.environment);
      if (unsupportedEnvironment !== undefined) throw new Error(unsupportedEnvironment);
      const unsupportedPolicy = unsupportedOpenShellPolicyReason(spec.policy);
      if (unsupportedPolicy !== undefined) throw new Error(unsupportedPolicy);
      const response = await client.raw.createSandbox({
        workspaceScope: DEFAULT_WORKSPACE_SCOPE,
        name: spec.name ?? "",
        labels: spec.labels === undefined ? {} : { ...spec.labels },
        annotations: {},
        awaitMainProcessAttachment: false,
        workloadTemplate: spec.template,
        requestId: spec.requestId ?? "",
        serviceExposures: [],
        ...(spec.policy === undefined
          ? {}
          : { spec: { policy: openShellWirePolicy(spec.policy) } }),
      });
      const created = response.sandbox;
      if (created === undefined) throw new Error("The gateway returned no sandbox after create.");
      return toWireSandboxView(created);
    },
    get: async (name) => {
      try {
        return toSandboxView(await client.sandbox.get(name));
      } catch (cause) {
        if (!isSandboxNotFoundError(cause)) throw cause;
        return null;
      }
    },
    listAll: async (selector) =>
      (
        await client.sandbox.listAll(
          selector === undefined
            ? undefined
            : { labelSelector: toLabelSelector(selector.labels ?? {}) },
        )
      ).map(toSandboxView),
    deleteSandbox: async (name, requestOptions) => {
      // The curated delete seam does not expose request ids in 0.1.7; use the
      // generated RPC so removal remains durably idempotent.
      const result = await client.raw.deleteSandbox({
        workspaceScope: DEFAULT_WORKSPACE_SCOPE,
        name,
        allowMissing: true,
        requestId: requestOptions?.requestId ?? "",
      });
      return parseWireDeleteOutcome(result.outcome);
    },
    waitReady: async (name, timeoutSecs) =>
      toSandboxView(await client.sandbox.waitReady(name, timeoutSecs)),
    exec: async (name, command) => {
      // Some SDK builds hand back Buffers; consumers expect strings.
      const result = await client.sandbox.exec(name, [...command]);
      return {
        exitCode: result.exitCode,
        stdout: String(result.stdout),
        stderr: String(result.stderr),
      };
    },
    listTemplates: async () => (await client.sandboxTemplates.listAll()).map(toTemplateView),
    createTemplate: async (spec) => {
      const driverConfig =
        spec.mounts === undefined || spec.mounts.length === 0
          ? undefined
          : {
              kubernetes: {
                volumes: spec.mounts.map((mount) => ({
                  name: mount.name,
                  persistent_volume_claim: {
                    claim_name: mount.pvc,
                    read_only: mount.readOnly === true,
                  },
                })),
                containers: {
                  agent: {
                    volume_mounts: spec.mounts.map((mount) => ({
                      name: mount.name,
                      mount_path: mount.mountPath,
                      read_only: mount.readOnly === true,
                    })),
                  },
                },
              },
            };
      return toTemplateView(
        await client.sandboxTemplates.create({
          metadata: {
            name: spec.name,
            ...(spec.role === undefined ? {} : { labels: { [TEMPLATE_ROLE_LABEL]: spec.role } }),
          },
          spec: {
            workload: {
              image: spec.image ?? "",
              environment: spec.environment === undefined ? {} : { ...spec.environment },
              ...(spec.cpu === undefined && spec.memory === undefined && spec.gpu === undefined
                ? {}
                : {
                    resources: {
                      cpu: spec.cpu ?? "",
                      memory: spec.memory ?? "",
                      ...(spec.gpu === undefined ? {} : { gpu: { count: spec.gpu } }),
                    },
                  }),
            },
            ...(driverConfig === undefined ? {} : { driverConfig }),
          },
        }),
      );
    },
  };
};
