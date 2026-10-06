import type {
  FlyMachineConfig,
  FlyStopConfigSignal,
} from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { MachineServiceCheck } from "./Machine.ts";
import { pinsFromConfig } from "./DeploymentImages.ts";

/** Replacement/readiness policy shared by Machines, Services, and websites; not an App-wide deployment lock. */
export interface MachineDeploy {
  /** Sequential in-place updates, or a checked replacement set. @default "rolling" */
  strategy: "rolling" | "bluegreen";
  /** Readiness deadline after startup, positive and at most 300 seconds. A deadline-only change does not replace Machines. @default "60 seconds" */
  healthTimeout?: Duration.Input;
}

/** Process shutdown policy. Retirement uses the predecessor's own policy; raw images and external website servers own signal handling and drain. */
export interface MachineShutdown {
  /** Signal sent before termination. Managed Services support SIGTERM and SIGINT. @default "SIGTERM" */
  signal?: Exclude<FlyStopConfigSignal, "SIGKILL">;
  /** Grace period, greater than zero and at most 300 seconds. @default "30 seconds" */
  timeout?: Duration.Input;
}

/** Named readiness check for a worker without public proxy ports. */
export interface MachineCheck extends MachineServiceCheck {
  /** Port inside the Machine to check. */
  port: number;
}

export class InvalidDeployment extends Data.TaggedError(
  "Fly.InvalidDeployment",
)<{
  message: string;
}> {}

export interface DeploymentPolicy {
  bluegreen: boolean;
  healthTimeoutMs: number;
  shutdown:
    | {
        signal: Exclude<FlyStopConfigSignal, "SIGKILL">;
        timeout: string;
        timeoutMs: number;
      }
    | undefined;
}

const duration = (value: Duration.Input, name: string, maximum: number) =>
  Effect.try({
    try: () => {
      const milliseconds = Duration.toMillis(value);
      if (
        !Number.isSafeInteger(milliseconds) ||
        milliseconds <= 0 ||
        milliseconds > maximum
      ) {
        throw new Error("invalid duration");
      }
      return milliseconds;
    },
    catch: () =>
      new InvalidDeployment({
        message: `${name} must be a finite positive duration no greater than ${maximum / 1000} seconds.`,
      }),
  });

export const deploymentPolicy = Effect.fn(function* (
  deploy: MachineDeploy | undefined,
  shutdown: MachineShutdown | undefined,
  managed = false,
) {
  const bluegreen = deploy?.strategy === "bluegreen";
  const healthTimeoutMs = yield* duration(
    deploy?.healthTimeout ?? "60 seconds",
    "deploy.healthTimeout",
    300_000,
  );
  const enabled = bluegreen || shutdown !== undefined;
  const signal = shutdown?.signal ?? "SIGTERM";
  if (
    enabled &&
    !["SIGHUP", "SIGINT", "SIGQUIT", "SIGUSR1", "SIGUSR2", "SIGTERM"].includes(
      signal,
    )
  ) {
    return yield* new InvalidDeployment({
      message:
        "shutdown.signal must be a supported graceful Fly signal, not SIGKILL.",
    });
  }
  if (managed && enabled && signal !== "SIGTERM" && signal !== "SIGINT") {
    return yield* new InvalidDeployment({
      message:
        "Managed Fly Services support SIGTERM and SIGINT shutdown signals.",
    });
  }
  const timeoutMs = enabled
    ? yield* duration(
        shutdown?.timeout ?? "30 seconds",
        "shutdown.timeout",
        300_000,
      )
    : undefined;
  return {
    bluegreen,
    healthTimeoutMs,
    shutdown:
      timeoutMs === undefined
        ? undefined
        : { signal, timeout: `${timeoutMs}ms`, timeoutMs },
  } satisfies DeploymentPolicy;
});

export const validateDeployment = (
  policy: DeploymentPolicy,
  config: FlyMachineConfig,
  mounted: boolean,
  skipLaunch = false,
) => {
  if (!policy.bluegreen) return Effect.void;
  let message: string | undefined;
  if (mounted)
    message =
      "Blue/green deployments cannot attach volumes, including MountVolume bindings.";
  else if (
    config.containers !== undefined &&
    pinsFromConfig(config) === undefined
  )
    message =
      "Blue/green multi-container Machines require unique names and immutable repository@sha256 image references for every container.";
  else if (skipLaunch || config.auto_destroy || config.restart?.policy === "no")
    message = "Blue/green deployments require a persistent, launched Machine.";
  else if (
    (config.services ?? []).some(
      (service) => (service.ports?.length ?? 0) > 0 && !service.checks?.length,
    )
  )
    message =
      "Every published service needs a service health check for blue/green deployment.";
  else if (
    !(config.services ?? []).some((service) => service.checks?.length) &&
    !Object.keys(config.checks ?? {}).length
  )
    message = "Blue/green deployments require readiness checks.";
  return message
    ? Effect.fail(new InvalidDeployment({ message }))
    : Effect.void;
};
