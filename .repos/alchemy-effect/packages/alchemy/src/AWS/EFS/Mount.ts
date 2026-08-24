import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isTask } from "../ECS/Task.ts";
import type { Function } from "../Lambda/Function.ts";
import type { AccessPoint } from "./AccessPoint.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Options for {@link Mount}.
 */
export interface MountOptions {
  /**
   * Local path the file system is mounted at inside the compute environment.
   * On Lambda the path must begin with `/mnt/` (e.g. `/mnt/data`); on ECS any
   * absolute container path works.
   */
  path: string;
  /**
   * Mount read-only: the role is granted `elasticfilesystem:ClientMount`
   * only (no `ClientWrite`), and on ECS the container mount point is marked
   * `readOnly`.
   * @default false
   */
  readOnly?: boolean;
}

/**
 * The runtime view of a mounted EFS file system: the local path it is
 * available at inside the running Function/Task.
 */
export interface MountedFileSystem {
  /** The local mount path (same value as {@link MountOptions.path}). */
  path: string;
}

/**
 * Host-agnostic EFS mount binding.
 *
 * `yield* EFS.mount(accessPoint, { path: "/mnt/data" })` inside a compute
 * body wires the file system into whatever host the code deploys to:
 *
 * - **Lambda** — injects a `FileSystemConfigs` entry (the access point ARN +
 *   local mount path) through the Function's binding channel and grants the
 *   execution role `elasticfilesystem:ClientMount`/`ClientWrite` scoped to
 *   the access point. Lambda requires an `AWS.EFS.AccessPoint` (not a bare
 *   file system) and a `/mnt/…` path, and the Function must have `vpc` set
 *   to subnets that can reach an EFS mount target.
 * - **ECS Task** — injects a task-level EFS volume (transit encryption on,
 *   IAM auth on, access-point scoped when one is given) plus a container
 *   mount point, and grants the task role the matching client actions.
 *
 * Provide the `EFS.MountLive` layer on the Function/Task Effect to satisfy
 * the binding. Mount targets for the file system's VPC/subnets must already
 * exist (`AWS.EFS.MountTarget`).
 * @binding
 */
export interface Mount extends Binding.Service<
  Mount,
  "AWS.EFS.Mount",
  (
    target: AccessPoint | FileSystem,
    options: MountOptions,
  ) => Effect.Effect<MountedFileSystem>
> {}
export const Mount = Binding.Service<Mount>("AWS.EFS.Mount");

/**
 * Ergonomic alias of {@link Mount} — `yield* EFS.mount(accessPoint, { path })`.
 */
export const mount = Mount;

const isAccessPoint = (
  target: AccessPoint | FileSystem,
): target is AccessPoint =>
  (target as { Type?: string }).Type === "AWS.EFS.AccessPoint";

const isLambdaFunction = (value: unknown): value is Function =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "AWS.Lambda.Function";

/**
 * Host-agnostic implementation of the {@link Mount} binding. Detects the
 * host (Lambda Function vs ECS Task) at deploy time and registers the
 * host-appropriate mount config + IAM through the binding channel; at
 * runtime it is a no-op that returns the mount path.
 */
export const MountLive = Layer.effect(
  Mount,
  Effect.gen(function* () {
    return Effect.fn(function* (
      target: AccessPoint | FileSystem,
      options: MountOptions,
    ) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        const actions = options.readOnly
          ? ["elasticfilesystem:ClientMount"]
          : ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"];

        if (isTask(host)) {
          // ECS: task-level EFS volume + container mount point. IAM auth +
          // transit encryption are always on so the task-role grant below is
          // what authorizes the mount.
          const volumeName = `efs-${target.LogicalId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
          yield* host.bind`Allow(${host}, AWS.EFS.Mount(${target}))`({
            policyStatements: [
              isAccessPoint(target)
                ? {
                    Effect: "Allow" as const,
                    Action: actions,
                    Resource: ["*"],
                    Condition: {
                      StringEquals: {
                        "elasticfilesystem:AccessPointArn":
                          target.accessPointArn,
                      },
                    },
                  }
                : {
                    Effect: "Allow" as const,
                    Action: actions,
                    Resource: [target.fileSystemArn],
                  },
            ],
            volumes: [
              {
                name: volumeName,
                efsVolumeConfiguration: {
                  fileSystemId: target.fileSystemId,
                  transitEncryption: "ENABLED",
                  authorizationConfig: isAccessPoint(target)
                    ? { accessPointId: target.accessPointId, iam: "ENABLED" }
                    : { iam: "ENABLED" },
                },
              },
            ],
            mountPoints: [
              {
                sourceVolume: volumeName,
                containerPath: options.path,
                readOnly: options.readOnly,
              },
            ],
          });
        } else if (isLambdaFunction(host)) {
          // Lambda: FileSystemConfigs entry + access-point-scoped client
          // access on the execution role. Lambda only mounts access points.
          if (!isAccessPoint(target)) {
            return yield* Effect.die(
              new Error(
                `AWS.EFS.Mount(${target.LogicalId}): Lambda can only mount an EFS access point — create an AWS.EFS.AccessPoint for the file system and mount that instead`,
              ),
            );
          }
          if (!options.path.startsWith("/mnt/")) {
            return yield* Effect.die(
              new Error(
                `AWS.EFS.Mount(${target.LogicalId}): Lambda mount paths must begin with /mnt/ (got ${options.path})`,
              ),
            );
          }
          yield* host.bind`Allow(${host}, AWS.EFS.Mount(${target}))`({
            policyStatements: [
              {
                Effect: "Allow" as const,
                Action: actions,
                Resource: ["*"],
                Condition: {
                  StringEquals: {
                    "elasticfilesystem:AccessPointArn": target.accessPointArn,
                  },
                },
              },
            ],
            fileSystemConfigs: [
              {
                arn: target.accessPointArn,
                localMountPath: options.path,
              },
            ],
          });
        } else {
          return yield* Effect.die(
            new Error(
              `AWS.EFS.Mount(${target.LogicalId}): unsupported host ${(host as { Type?: string }).Type} — EFS mounts are supported on AWS.Lambda.Function and AWS.ECS.Task`,
            ),
          );
        }
      }
      return { path: options.path };
    });
  }),
);
