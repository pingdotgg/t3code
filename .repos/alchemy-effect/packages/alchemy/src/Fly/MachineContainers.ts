import type {
  FlyContainerConfig,
  FlyMachineConfig,
} from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { MachineContainer, MachineProps } from "./Machine.ts";

import { deepEqual } from "../Diff.ts";

export class InvalidMachineContainers extends Data.TaggedError(
  "Fly.InvalidMachineContainers",
)<{
  message: string;
}> {}

/** Validate resolved inputs before any Machine or Volume is changed. */
export const validateMachineContainers = (
  props: Pick<MachineProps, "image" | "containers" | "init">,
) => {
  const image = "image" in props ? props.image : undefined;
  const containers = "containers" in props ? props.containers : undefined;
  if ((image !== undefined) === (containers !== undefined))
    return Effect.fail(
      new InvalidMachineContainers({
        message: "Fly.Machine requires exactly one of image or containers.",
      }),
    );
  if (image !== undefined)
    return typeof image === "string" && image.trim().length > 0
      ? Effect.void
      : Effect.fail(
          new InvalidMachineContainers({ message: "image must be nonempty." }),
        );
  if (!Array.isArray(containers) || containers.length === 0)
    return Effect.fail(
      new InvalidMachineContainers({
        message: "containers must be a nonempty array.",
      }),
    );
  if (props.init !== undefined)
    return Effect.fail(
      new InvalidMachineContainers({
        message: "init is only supported with image.",
      }),
    );
  const names = new Set<string>();
  for (const container of containers) {
    if (
      container == null ||
      typeof container.name !== "string" ||
      !container.name.trim() ||
      typeof container.image !== "string" ||
      !container.image.trim()
    )
      return Effect.fail(
        new InvalidMachineContainers({
          message: "Every container needs a nonempty name and image.",
        }),
      );
    if ("exec" in container && container.exec !== undefined)
      return Effect.fail(
        new InvalidMachineContainers({
          message: `Container ${container.name}: use cmd and entrypoint; native container exec overrides are not supported.`,
        }),
      );
    if (names.has(container.name))
      return Effect.fail(
        new InvalidMachineContainers({
          message: `Duplicate container name: ${container.name}.`,
        }),
      );
    names.add(container.name);
  }
  for (const container of containers)
    for (const dependency of container.dependsOn ?? [])
      if (
        dependency == null ||
        typeof dependency.name !== "string" ||
        !names.has(dependency.name)
      )
        return Effect.fail(
          new InvalidMachineContainers({
            message: `Container ${container.name} depends on an undeclared container.`,
          }),
        );
  return Effect.void;
};

export const toFlyContainers = (
  containers: MachineContainer[],
): FlyContainerConfig[] =>
  containers.map((container) => ({
    name: container.name,
    image: container.image,
    cmd: container.cmd,
    entrypoint: container.entrypoint,
    env: container.env,
    depends_on: container.dependsOn?.map(({ name, condition }) => ({
      name,
      condition,
    })),
    healthchecks: container.healthChecks?.map((check) => ({
      name: check.name,
      kind: check.kind,
      interval: check.interval,
      timeout: check.timeout,
      grace_period: check.gracePeriod,
      success_threshold: check.successThreshold,
      failure_threshold: check.failureThreshold,
      http: check.http && {
        port: check.http.port,
        path: check.http.path,
        method: check.http.method,
        scheme: check.http.scheme,
        headers: check.http.headers,
        tls_server_name: check.http.tlsServerName,
        tls_skip_verify: check.http.tlsSkipVerify,
      },
      tcp: check.tcp,
      exec: check.exec,
    })),
  }));

/** Canonical semantic config shared by drift detection and generation identity. */
export const canonicalContainers = (
  containers: FlyContainerConfig[] | undefined,
) =>
  (containers ?? [])
    .map((container) => ({
      name: container.name,
      image: container.image,
      cmd: container.cmd,
      entrypoint: container.entrypoint,
      env: Object.fromEntries(
        Object.entries(container.env ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      ),
      depends_on: [...(container.depends_on ?? [])]
        .map(({ name, condition }) => ({ name, condition }))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      healthchecks: (container.healthchecks ?? []).map((check) => ({
        name: check.name,
        kind: check.kind,
        interval: check.interval,
        timeout: check.timeout,
        grace_period: check.grace_period,
        success_threshold: check.success_threshold,
        failure_threshold: check.failure_threshold,
        http: check.http,
        tcp: check.tcp,
        exec: check.exec,
      })),
    }))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

export const sameContainers = (
  observed: FlyContainerConfig[] | undefined,
  desired: FlyContainerConfig[] | undefined,
) =>
  deepEqual(canonicalContainers(observed), canonicalContainers(desired), {
    stripNullish: true,
  });

/** Fly may synthesize a top-level image from the first container on readback. */
export const sameContainerWorkload = (
  observed: FlyMachineConfig | undefined,
  desired: FlyContainerConfig[],
) => sameContainers(observed?.containers, desired);
