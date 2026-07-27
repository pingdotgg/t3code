import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Shared scaffolding for the EFS runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeEfs…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation, the IAM action list, and
 * (for file-system-scoped operations) the injected `FileSystemId` is
 * boilerplate.
 */

/**
 * Build the impl Effect for a file-system-scoped EFS operation: the runtime
 * callable injects the bound {@link FileSystem}'s ID as `FileSystemId` and
 * the deploy-time half grants `actions` on the file system's ARN.
 */
export const makeEfsFileSystemHttpBinding = <
  I extends { FileSystemId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EFS.DescribeMountTargets`. */
  tag: string;
  /** The distilled operation; `FileSystemId` is injected from the file system. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the file system ARN. */
  actions: readonly string[];
  /**
   * Additional IAM actions granted on `*`. Used for tag-on-create
   * (`elasticfilesystem:TagResource` authorizes against the ARN of the
   * resource being created, which is unknowable at deploy time).
   */
  wildcardActions?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (fileSystem: FileSystem) {
      const FileSystemId = yield* fileSystem.fileSystemId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${fileSystem}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${fileSystem.fileSystemArn}`],
              },
              ...(options.wildcardActions !== undefined &&
              options.wildcardActions.length > 0
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: [...options.wildcardActions],
                      Resource: ["*"],
                    },
                  ]
                : []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${fileSystem.LogicalId})`)(function* (
        request?: Omit<I, "FileSystemId">,
      ) {
        return yield* op({
          ...request,
          FileSystemId: yield* FileSystemId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level EFS operation (no file-system
 * argument): the deploy-time half grants `actions` on `*`. Used for
 * operations that authorize against ARNs unknowable at deploy time (e.g.
 * `DeleteAccessPoint` authorizes on the access point's own ARN, and access
 * points deleted at runtime are typically created at runtime too).
 */
export const makeEfsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EFS.DeleteAccessPoint`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
