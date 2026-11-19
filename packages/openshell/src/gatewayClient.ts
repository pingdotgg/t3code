import { OpenShellSandboxTemplate, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
  /** Per-sandbox environment overrides on top of the template's, e.g. the spawn seed. */
  readonly environment?: Readonly<Record<string, string>>;
}

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
  /** Per-sandbox policy, e.g. the translated runtime-mode policy (spec section 5.2). */
  readonly setPolicy: (name: string, policy: unknown) => Promise<void>;
  readonly listTemplates: () => Promise<ReadonlyArray<OpenShellSandboxTemplate>>;
  readonly createTemplate: (spec: OpenShellTemplateCreateSpec) => Promise<OpenShellSandboxTemplate>;
}

interface OpenShellSdkSandbox {
  readonly name?: string;
  readonly id?: string;
  readonly sandboxId?: string;
  readonly phase?: string;
  readonly labels?: Record<string, string>;
  readonly createdAt?: string | number;
}

interface OpenShellSdkClient {
  health(): Promise<unknown>;
  sandbox: {
    createFromTemplate(spec: Record<string, unknown>): Promise<OpenShellSdkSandbox>;
    get(name: string): Promise<OpenShellSdkSandbox>;
    listAll(selector?: { labels?: Record<string, string> }): Promise<OpenShellSdkSandbox[]>;
    delete(name: string, options?: Record<string, unknown>): Promise<string>;
    waitReady(name: string, timeoutSecs: number): Promise<OpenShellSdkSandbox>;
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    setPolicy(name: string, policy: unknown): Promise<unknown>;
  };
  sandboxTemplates(): {
    list(): Promise<unknown[]>;
    create(spec: Record<string, unknown>): Promise<unknown>;
  };
}

interface OpenShellSdkModule {
  OpenShellClient: { connect(options: Record<string, unknown>): Promise<OpenShellSdkClient> };
}

export interface ConnectOpenShellGatewayOptions {
  readonly gatewayUrl: string;
  /**
   * Token provider as the SDK expects it, e.g. its `clientCredentials({...})`
   * renewable provider (lane 1, docs/sdk/typescript.mdx). Passed through.
   */
  readonly oidcTokenProvider?: unknown;
}

/**
 * OPEN (lane 1): `@nvidia/openshell-sdk` ships via GitHub Packages only
 * (`@nvidia` scope on `npm.pkg.github.com`), which this checkout cannot
 * authenticate against, so the dependency is absent from package.json. Pin
 * `"@nvidia/openshell-sdk": "0.1.7"` once the credential exists.
 */
const OPEN_SHELL_SDK_MODULE = "@nvidia/openshell-sdk";

const toSandboxView = (sandbox: OpenShellSdkSandbox): OpenShellSandboxView => {
  const name = sandbox.name ?? "";
  if (name === "") throw new Error("The gateway returned a sandbox without a name.");
  const createdAt =
    typeof sandbox.createdAt === "number"
      ? sandbox.createdAt
      : typeof sandbox.createdAt === "string"
        ? Number.isNaN(Date.parse(sandbox.createdAt))
          ? null
          : Date.parse(sandbox.createdAt)
        : null;
  return {
    name,
    sandboxId: sandbox.sandboxId ?? sandbox.id ?? name,
    phase: sandbox.phase ?? "",
    labels: sandbox.labels ?? {},
    createdAt,
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
  if (nullish.status === 404 || nullish.statusCode === 404) return true;
  if (nullish.code === "not_found" || nullish.code === "NOT_FOUND") return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b404\b|not found/i.test(message);
};

const templateFromUnknown = Schema.decodeUnknownSync(OpenShellSandboxTemplate);

/**
 * Normalizes a gateway delete answer to the contracts' typed outcomes. SDK 0.1.7
 * answers with an object ({ outcome }); older shapes answered with the string
 * alone. Throws when the answer is unreadable, so a delete never lies.
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

/**
 * Connects the real SDK and adapts it to {@link OpenShellGatewayClient}. The
 * delete outcome is lowercased to the contracts' typed values.
 */
export const connectOpenShellGateway = async (
  options: ConnectOpenShellGatewayOptions,
): Promise<OpenShellGatewayClient> => {
  const specifier = OPEN_SHELL_SDK_MODULE;
  let sdk: OpenShellSdkModule;
  try {
    sdk = (await import(specifier)) as OpenShellSdkModule;
  } catch (cause) {
    throw new Error(
      "The OpenShell SDK is not installed here: add @nvidia/openshell-sdk (GitHub Packages, see packages/openshell/src/gatewayClient.ts) to use a real gateway.",
      { cause },
    );
  }
  const client = await sdk.OpenShellClient.connect({
    gateway: options.gatewayUrl,
    ...(options.oidcTokenProvider === undefined
      ? {}
      : { oidcTokenProvider: options.oidcTokenProvider }),
  });
  return {
    health: async () => {
      await client.health();
    },
    createFromTemplate: async (spec) =>
      toSandboxView(
        await client.sandbox.createFromTemplate({
          template: spec.template,
          ...(spec.name === undefined ? {} : { name: spec.name }),
          ...(spec.labels === undefined ? {} : { labels: { ...spec.labels } }),
          ...(spec.requestId === undefined ? {} : { request_id: spec.requestId }),
          ...(spec.environment === undefined ? {} : { environment: { ...spec.environment } }),
        }),
      ),
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
          selector === undefined ? undefined : { labels: { ...selector.labels } },
        )
      ).map(toSandboxView),
    deleteSandbox: async (name, requestOptions) => {
      const result = await client.sandbox.delete(
        name,
        requestOptions?.requestId === undefined
          ? undefined
          : { request_id: requestOptions.requestId },
      );
      return parseDeleteOutcome(result);
    },
    waitReady: async (name, timeoutSecs) =>
      toSandboxView(await client.sandbox.waitReady(name, timeoutSecs)),
    exec: async (name, command) => await client.sandbox.exec(name, [...command]),
    setPolicy: async (name, policy) => {
      await client.sandbox.setPolicy(name, policy);
    },
    listTemplates: async () =>
      (await client.sandboxTemplates().list()).map((template) => templateFromUnknown(template)),
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
      return templateFromUnknown(
        await client.sandboxTemplates().create({
          name: spec.name,
          ...(spec.image === undefined ? {} : { image: spec.image }),
          ...(spec.cpu === undefined ? {} : { cpu: spec.cpu }),
          ...(spec.memory === undefined ? {} : { memory: spec.memory }),
          ...(spec.gpu === undefined ? {} : { gpu: spec.gpu }),
          ...(spec.environment === undefined ? {} : { environment: { ...spec.environment } }),
          ...(driverConfig === undefined ? {} : { driver_config: driverConfig }),
          ...(spec.role === undefined ? {} : { labels: { [TEMPLATE_ROLE_LABEL]: spec.role } }),
        }),
      );
    },
  };
};
