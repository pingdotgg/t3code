import * as Effect from "effect/Effect";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { ArtifactsBinding } from "./ArtifactsBinding.ts";

type ArtifactsTypeId = typeof ArtifactsTypeId;
const ArtifactsTypeId = "Cloudflare.Artifacts" as const;

/**
 * Cloudflare validation: 3–63 chars, lowercase alphanumeric and hyphens, must
 * start and end with a lowercase alphanumeric character.
 */
const ARTIFACTS_NAMESPACE_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

export class InvalidArtifactsNamespaceError extends Error {
  readonly _tag = "InvalidArtifactsNamespaceError" as const;
  constructor(public readonly namespace: string) {
    super(
      `Invalid artifacts namespace name '${namespace}'. Must be 3-63 characters, start and end with a lowercase alphanumeric character, and contain only lowercase alphanumeric characters and hyphens.`,
    );
  }
}

export type ArtifactsProps = {
  /**
   * Cloudflare namespace name. Namespaces are implicit on Cloudflare — the
   * first repo created against this name conjures the namespace.
   *
   * Must be 3–63 lowercase alphanumeric characters or hyphens, and must start
   * and end with a lowercase alphanumeric character. If omitted, a unique
   * physical name is generated from the resource's logical id, app, and stage.
   */
  namespace?: string;
};

/**
 * Marker for a Cloudflare Artifacts namespace binding.
 *
 * Artifacts namespaces are implicit (created on first repo write) and require
 * no deploy-time provisioning, so this is a pure binding marker rather than
 * a full Resource. The Worker provider sees this object in `bindings: { ... }`
 * and emits the corresponding `{ type: "artifacts", name, namespace }` binding
 * to the script.
 */
export type Artifacts = {
  kind: ArtifactsTypeId;
  name: string;
  namespace: string;
};

export const isArtifacts = (value: unknown): value is Artifacts =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as Artifacts).kind === ArtifactsTypeId;

/**
 * A Cloudflare Artifacts namespace — the top-level container for Git-compatible
 * versioned repositories. See the
 * {@link https://blog.cloudflare.com/artifacts-git-for-agents-beta/ | Artifacts launch post}
 * and {@link https://developers.cloudflare.com/artifacts/concepts/namespaces/ | Namespaces docs}.
 *
 * Namespaces on Cloudflare are **implicit**: there is no `POST /namespaces`
 * endpoint. The namespace is conjured the first time a repo is created against
 * it (either via the REST API or the Worker binding). Because of that, the
 * Alchemy "resource" is a thin binding marker — there is nothing to provision
 * at deploy time. Repos themselves are typically created at runtime through
 * the bound `Artifacts` API.
 *
 * @section Declaring a Namespace
 * @example Default namespace (a unique physical name is generated)
 * ```typescript
 * const Repos = Cloudflare.Artifacts("Repos");
 * ```
 *
 * @example Override the namespace name (must be lowercase, 3–63 chars)
 * ```typescript
 * const Repos = Cloudflare.Artifacts("Repos", { namespace: "starter-repos" });
 * ```
 *
 * @section Binding to a Worker
 * @example Wiring it into a Worker
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: { Repos },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { Repos: Artifacts }
 * ```
 *
 * @example Async-style worker
 * ```typescript
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     const repo = await env.Repos.create("starter-repo");
 *     return Response.json({ remote: repo.remote, token: repo.token });
 *   },
 * };
 * ```
 *
 * @example Effect-style worker
 * ```typescript
 * const artifacts = yield* Cloudflare.Artifacts.bind(Repos);
 * const repo = yield* artifacts.create("starter-repo", {
 *   setDefaultBranch: "main",
 * });
 * ```
 */
export const Artifacts: {
  (
    name: string,
    props?: ArtifactsProps,
  ): Effect.Effect<Artifacts, never, Stack | Stage>;
  /**
   * Bind a Cloudflare Artifacts namespace to the surrounding Worker, returning
   * an Effect-native client. See {@link ArtifactsBinding}.
   */
  bind: typeof ArtifactsBinding.bind;
} = Object.assign(
  Effect.fn(function* (name: string, props?: ArtifactsProps) {
    const namespace = props?.namespace
      ? props.namespace
      : name.toLocaleLowerCase();
    if (!ARTIFACTS_NAMESPACE_REGEX.test(namespace)) {
      return yield* Effect.die(new InvalidArtifactsNamespaceError(namespace));
    }
    return {
      kind: ArtifactsTypeId,
      name,
      namespace,
    } satisfies Artifacts;
  }),
  {
    bind: (...args: Parameters<typeof ArtifactsBinding.bind>) =>
      ArtifactsBinding.bind(...args),
  },
);
