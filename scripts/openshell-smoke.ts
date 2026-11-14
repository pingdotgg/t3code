// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off extendsNativeError:off - a plain-TS orchestrator around the Effect-based gateway client (mirrors release-smoke.ts, not an Effect program)
/**
 * Opt-in live smoke for the OpenShell fleet integration (CI:
 * .github/workflows/openshell-smoke.yml). Without the OPENSHELL_SMOKE_* secrets
 * it prints SKIPPED and exits 0, so PRs stay green. Secrets are never logged.
 */
import * as NodeCrypto from "node:crypto";
import { TrimmedNonEmptyString, type OpenShellSandboxTemplate } from "@t3tools/contracts";
import {
  FLEET_ROLE_LABEL,
  MANAGED_BY_LABEL,
  WORKER_CLASS_LABEL,
  connectOpenShellGateway,
  type OpenShellGatewayClient,
} from "@t3tools/openshell/gatewayClient";
import * as Schema from "effect/Schema";

export const DEFAULT_TIMEOUT_SECS = 900;
export const SMOKE_MANAGED_BY = "t3-fleet";

const TimeoutSecs = Schema.NumberFromString.check(
  Schema.makeFilter((secs: number) => Number.isInteger(secs) && secs > 0, {
    expected: "a positive whole number of seconds",
  }),
);

const SmokeEnvSchema = Schema.Struct({
  gatewayUrl: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  template: Schema.optionalKey(TrimmedNonEmptyString),
  timeoutSecs: Schema.optionalKey(TimeoutSecs),
});

export type SmokeConfig = Schema.Schema.Type<typeof SmokeEnvSchema>;

export type SmokePlan =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "run"; readonly config: SmokeConfig };

const ENV = {
  gatewayUrl: "OPENSHELL_SMOKE_GATEWAY_URL",
  credential: "OPENSHELL_SMOKE_GATEWAY_CREDENTIAL",
  template: "OPENSHELL_SMOKE_TEMPLATE",
  timeoutSecs: "OPENSHELL_SMOKE_TIMEOUT_SECS",
} as const;

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

const decodeSmokeEnv = Schema.decodeUnknownSync(SmokeEnvSchema);

/**
 * Resolves the CI environment into a skip, an actionable validation error, or
 * a run. Both secrets unset is the expected contributor state (skip); exactly
 * one set is a misconfiguration the administrator must fix (invalid).
 */
export const parseSmokeEnv = (raw: NodeJS.ProcessEnv): SmokePlan => {
  const hasGatewayUrl = isSet(raw[ENV.gatewayUrl]);
  const hasCredential = isSet(raw[ENV.credential]);
  if (!hasGatewayUrl && !hasCredential) {
    return {
      kind: "skip",
      reason:
        `${ENV.gatewayUrl} and ${ENV.credential} are not configured. ` +
        "A repository administrator can set them as repository secrets to run the live gateway smoke; pull requests stay green without them.",
    };
  }
  if (hasGatewayUrl !== hasCredential) {
    const missing = hasGatewayUrl ? ENV.credential : ENV.gatewayUrl;
    const present = hasGatewayUrl ? ENV.gatewayUrl : ENV.credential;
    return {
      kind: "invalid",
      message:
        `${present} is set but ${missing} is not. Set both as repository secrets, ` +
        "or unset both so the smoke skips cleanly.",
    };
  }
  try {
    const config = decodeSmokeEnv(
      {
        gatewayUrl: raw[ENV.gatewayUrl]?.trim(),
        credential: raw[ENV.credential]?.trim(),
        ...(isSet(raw[ENV.template]) ? { template: raw[ENV.template]?.trim() } : {}),
        ...(isSet(raw[ENV.timeoutSecs]) ? { timeoutSecs: raw[ENV.timeoutSecs]?.trim() } : {}),
      },
      { onExcessProperty: "ignore" },
    );
    return { kind: "run", config };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    return {
      kind: "invalid",
      message: `The ${ENV.gatewayUrl.slice(0, "OPENSHELL_SMOKE_".length)}* environment variables are invalid: ${detail}`,
    };
  }
};

/** Deterministic sandbox name for this run, e.g. `t3-smoke-1a2b3c4d5e`. */
export const smokeSandboxName = (seed: string): string =>
  `t3-smoke-${NodeCrypto.createHash("sha256").update(seed).digest("hex").slice(0, 10)}`;

export type TemplateChoice =
  | { readonly ok: true; readonly template: string }
  | { readonly ok: false; readonly message: string };

/**
 * Template selection mirrors the driver's (spec sections 4.2 and 5.1): the
 * explicit override first, then a worker-labeled template, then the first
 * listed. Nothing is created behind the caller's back.
 */
export const chooseTemplate = (
  templates: ReadonlyArray<OpenShellSandboxTemplate>,
  override?: string,
): TemplateChoice => {
  if (override !== undefined) {
    if (templates.some((template) => template.name === override)) {
      return { ok: true, template: override };
    }
    const listed =
      templates.length === 0
        ? "the gateway lists no templates"
        : `the gateway lists: ${templates.map((template) => template.name).join(", ")}`;
    return {
      ok: false,
      message:
        `Template ${override} is not on the gateway (${listed}). ` +
        "Fix OPENSHELL_SMOKE_TEMPLATE or provision that template on the gateway.",
    };
  }
  const worker = templates.find((template) => template.role === "worker") ?? templates[0];
  if (worker === undefined) {
    return {
      ok: false,
      message:
        "The gateway exposes no sandbox templates, so no worker can be spawned. " +
        `Ask the gateway administrator to provision a minimal worker template, or set ${ENV.template} to an existing template name.`,
    };
  }
  return { ok: true, template: worker.name };
};

/** A failure that names the smoke phase it happened in. */
export class OpenShellSmokeError extends Error {
  readonly phase: string;
  constructor(phase: string, message: string, options?: { cause: unknown }) {
    super(`${phase}: ${message}`, options);
    this.name = "OpenShellSmokeError";
    this.phase = phase;
  }
}

interface PhaseTimings {
  readonly name: string;
  readonly millis: number;
}

/** Rejects once the overall deadline passes, so a hung gateway call fails instead of stalling the job. */
const withDeadline = async <T>(
  promise: Promise<T>,
  deadlineAt: number,
  phase: string,
  action: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        reject(
          new OpenShellSmokeError(
            phase,
            `Timed out while ${action}. Check that the gateway answers and raise OPENSHELL_SMOKE_TIMEOUT_SECS if the budget is too tight.`,
          ),
        );
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis).unref();
  });

const spawnLabels = (): Record<string, string> => ({
  [FLEET_ROLE_LABEL]: "worker",
  // The driver's default managed-by value (OpenShellGatewayDriver, no managing id configured).
  [MANAGED_BY_LABEL]: SMOKE_MANAGED_BY,
  [WORKER_CLASS_LABEL]: "ephemeral",
});

/**
 * Runs the live flow: connect -> templates -> spawn an ephemeral worker ->
 * verify the fleet row and its labels -> drain-first removal -> verify the
 * sandbox and the fleet entry are gone. Mirrors OpenShellFleetService's real
 * wiring (the same lazy SDK import and token-provider shape), not fakes.
 */
export const runSmoke = async (
  config: SmokeConfig,
): Promise<{
  readonly phases: ReadonlyArray<PhaseTimings>;
  readonly sandboxName: string;
  readonly template: string;
}> => {
  const deadlineAt = Date.now() + (config.timeoutSecs ?? DEFAULT_TIMEOUT_SECS) * 1000;
  const phases: PhaseTimings[] = [];
  const time = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await run();
    } catch (cause) {
      throw cause instanceof OpenShellSmokeError
        ? cause
        : new OpenShellSmokeError(name, cause instanceof Error ? cause.message : String(cause), {
            cause,
          });
    } finally {
      phases.push({ name, millis: Date.now() - startedAt });
    }
  };

  let client: OpenShellGatewayClient | undefined;
  let sandboxName: string | undefined;
  try {
    client = await time("connect", () =>
      withDeadline(
        connectOpenShellGateway({
          gatewayUrl: config.gatewayUrl,
          // Same provider shape the fleet service uses (OpenShellFleetService.openClient).
          oidcTokenProvider: () => Promise.resolve(config.credential),
        }),
        deadlineAt,
        "connect",
        "connecting to the gateway",
      ),
    );
    const gateway = client;
    await time("health", () =>
      withDeadline(gateway.health(), deadlineAt, "health", "checking the gateway health"),
    );

    const template = await time("list-templates", async () => {
      const templates = await withDeadline(
        gateway.listTemplates(),
        deadlineAt,
        "list-templates",
        "listing sandbox templates",
      );
      const choice = chooseTemplate(templates, config.template);
      if (!choice.ok) throw new OpenShellSmokeError("list-templates", choice.message);
      return choice.template;
    });

    const name = smokeSandboxName(`${config.gatewayUrl}:${Date.now()}`);
    const labels = spawnLabels();
    sandboxName = name;
    await time("spawn", async () => {
      await withDeadline(
        gateway.createFromTemplate({
          template,
          name,
          labels,
          requestId: `t3-smoke:${name}`,
        }),
        deadlineAt,
        "spawn",
        "creating the smoke sandbox",
      );
      const remainingSecs = Math.max(1, Math.floor((deadlineAt - Date.now()) / 1000));
      const ready = await withDeadline(
        gateway.waitReady(name, remainingSecs),
        deadlineAt,
        "spawn",
        "waiting for the smoke sandbox to become ready",
      );
      if (!ready.phase.toLowerCase().includes("ready")) {
        throw new OpenShellSmokeError(
          "spawn",
          `Sandbox ${name} is in phase ${ready.phase} instead of ready. Check the gateway and the ${template} template's image.`,
        );
      }
    });

    await time("fleet-row", async () => {
      const fleet = await withDeadline(
        gateway.listAll({ labels: { [MANAGED_BY_LABEL]: SMOKE_MANAGED_BY } }),
        deadlineAt,
        "fleet-row",
        "listing the fleet index",
      );
      const row = fleet.find((sandbox) => sandbox.name === name);
      if (row === undefined) {
        throw new OpenShellSmokeError(
          "fleet-row",
          `Sandbox ${name} is ready but missing from the fleet index for ${MANAGED_BY_LABEL}=${SMOKE_MANAGED_BY}. Check the gateway's label filtering.`,
        );
      }
      for (const [label, value] of Object.entries(labels)) {
        if (row.labels[label] !== value) {
          throw new OpenShellSmokeError(
            "fleet-row",
            `Sandbox ${name} carries ${label}=${row.labels[label] ?? "<unset>"} instead of ${value}.`,
          );
        }
      }
    });

    await time("remove", async () => {
      // Force removal with drain: the driver's typed gateway outcome (contracts
      // spec section 5.3); a fresh smoke sandbox holds no threads, so the
      // gateway must complete the deletion outright.
      const outcome = await withDeadline(
        gateway.deleteSandbox(name, { requestId: `t3-remove:${name}` }),
        deadlineAt,
        "remove",
        "deleting the smoke sandbox",
      );
      if (outcome === "already_absent") {
        throw new OpenShellSmokeError(
          "remove",
          `The gateway reported ${name} as already absent right after it was ready; the deletion path cannot be trusted.`,
        );
      }
      while (Date.now() < deadlineAt) {
        if ((await gateway.get(name)) === null) return;
        await sleep(2000);
      }
      throw new OpenShellSmokeError(
        "remove",
        `Sandbox ${name} still answers to client.get after a ${outcome} deletion. Check the gateway's garbage collection.`,
      );
    });

    await time("fleet-index-clean", async () => {
      const fleet = await withDeadline(
        gateway.listAll({ labels: { [MANAGED_BY_LABEL]: SMOKE_MANAGED_BY } }),
        deadlineAt,
        "fleet-index-clean",
        "re-listing the fleet index",
      );
      if (fleet.some((sandbox) => sandbox.name === name)) {
        throw new OpenShellSmokeError(
          "fleet-index-clean",
          `Sandbox ${name} was deleted but still appears in the fleet index. Check the gateway's list filtering.`,
        );
      }
    });

    return { phases, sandboxName: name, template };
  } finally {
    // Never leave smoke debris on the fleet, even after a failure mid-flow.
    if (client !== undefined && sandboxName !== undefined) {
      try {
        if ((await client.get(sandboxName)) !== null) {
          await client.deleteSandbox(sandboxName, { requestId: `t3-cleanup:${sandboxName}` });
          console.log(`[cleanup] removed leftover sandbox ${sandboxName}`);
        }
      } catch (cleanupCause) {
        console.error(
          `[cleanup] could not remove sandbox ${sandboxName}; the gateway's orphan sweep should reclaim it: ${
            cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
          }`,
        );
      }
    }
  }
};

const report = (result: {
  readonly phases: ReadonlyArray<PhaseTimings>;
  readonly sandboxName: string;
  readonly template: string;
}): string =>
  [
    `PASS: OpenShell gateway smoke (sandbox ${result.sandboxName}, template ${result.template})`,
    ...result.phases.map(
      (phase) =>
        `  ${phase.name.padEnd(18)} ${phase.millis >= 1000 ? `${(phase.millis / 1000).toFixed(1)}s` : `${phase.millis}ms`}`,
    ),
    `  total             ${(result.phases.reduce((sum, phase) => sum + phase.millis, 0) / 1000).toFixed(1)}s`,
  ].join("\n");

if (import.meta.main) {
  const plan = parseSmokeEnv(process.env);
  if (plan.kind === "skip") {
    console.log(`SKIPPED: ${plan.reason}`);
  } else if (plan.kind === "invalid") {
    console.error(`INVALID: ${plan.message}`);
    process.exitCode = 1;
  } else {
    try {
      console.log(report(await runSmoke(plan.config)));
    } catch (cause) {
      console.error(
        cause instanceof OpenShellSmokeError
          ? `FAIL: OpenShell gateway smoke failed while ${cause.phase}: ${cause.message}`
          : `FAIL: OpenShell gateway smoke failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      process.exitCode = 1;
    }
  }
}
