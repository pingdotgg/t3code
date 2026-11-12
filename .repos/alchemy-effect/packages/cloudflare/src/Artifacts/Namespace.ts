import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

type NamespaceTypeId = typeof NamespaceTypeId;
const NamespaceTypeId = "Cloudflare.Artifacts.Namespace" as const;

/**
 * Cloudflare validation: 2–63 chars, starting with a letter or digit, followed
 * by letters, digits, `.`, `_`, or `-`. See
 * https://developers.cloudflare.com/artifacts/platform/limits/.
 */
const ARTIFACTS_NAMESPACE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

export class InvalidNamespaceError extends Data.TaggedError("InvalidNamespaceError")<{
  readonly namespace: string;
}> {
  override get message() {
    return `Invalid artifacts namespace name '${this.namespace}'. Must be 2-63 characters, start with a letter or digit, and contain only letters, digits, ".", "_", and "-".`;
  }
}

export type NamespaceProps = {
  /**
   * Cloudflare namespace name. The first repo created against a name that
   * does not exist yet creates the namespace.
   *
   * Must be 2–63 characters, start with a letter or digit, and contain only
   * letters, digits, `.`, `_`, or `-`. If omitted, the lowercased logical id
   * is used.
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
export type Namespace = {
  kind: NamespaceTypeId;
  name: string;
  namespace: string;
};

export const isNamespace = (value: unknown): value is Namespace =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as Namespace).kind === NamespaceTypeId;

/**
 * A Cloudflare Artifacts namespace — the top-level container for Git-compatible
 * versioned repositories. See the
 * {@link https://blog.cloudflare.com/artifacts-git-for-agents-beta/ | Artifacts launch post}
 * and {@link https://developers.cloudflare.com/artifacts/concepts/namespaces/ | Namespaces docs}.
 *
 * Cloudflare creates a namespace implicitly the first time a repo is created
 * against it (through the REST API or the Worker binding), so the Alchemy
 * "resource" is a thin binding marker with nothing to provision at deploy
 * time. Cloudflare also offers an explicit `POST /artifacts/namespaces` route,
 * needed only to pin a data-location `jurisdiction`; this marker does not
 * call it. Repos themselves are typically created at runtime through
 * the bound `Artifacts` API.
 *
 * Unlike the other Worker-only bindings, an Artifacts namespace does **not**
 * auto-bind when yielded — it always requires an explicit access level via
 * {@link ReadNamespace} / {@link WriteNamespace} / {@link ReadWriteNamespace}.
 *
 * ### Declaring a Namespace
 * **Example:** Default namespace (a unique physical name is generated)
 * ```typescript
 * const Repos = Cloudflare.Artifacts.Namespace("Repos");
 * ```
 *
 * **Example:** Override the namespace name (2–63 chars)
 * ```typescript
 * const Repos = Cloudflare.Artifacts.Namespace("Repos", { namespace: "starter-repos" });
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Wiring it into a Worker
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
 * **Example:** Async-style worker
 * ```typescript
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     const repo = await env.Repos.create("starter-repo");
 *     return Response.json({ remote: repo.remote, token: repo.token });
 *   },
 * };
 * ```
 *
 * **Example:** Effect-style worker (explicit access level)
 * ```typescript
 * const artifacts = yield* Cloudflare.Artifacts.ReadWriteNamespace(Repos);
 * const repo = yield* artifacts.create("starter-repo", {
 *   setDefaultBranch: "main",
 * });
 * ```
 *
 * **Example:** Effect-style worker reading history (read-only access)
 * ```typescript
 * const artifacts = yield* Cloudflare.Artifacts.ReadNamespace(Repos);
 * const repo = yield* artifacts.get("starter-repo");
 * const commits = yield* repo.log({ ref: "main", limit: 10 });
 * const readme = yield* repo.readFile({ ref: "main", path: "README.md" });
 * ```
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export const Namespace: (
  name: string,
  props?: NamespaceProps,
) => Effect.Effect<Namespace, never, Stack | Stage> = Effect.fn(function* (
  name: string,
  props?: NamespaceProps,
) {
  const namespace = props?.namespace ? props.namespace : name.toLocaleLowerCase();
  if (!ARTIFACTS_NAMESPACE_REGEX.test(namespace)) {
    return yield* Effect.die(new InvalidNamespaceError({ namespace }));
  }
  return {
    kind: NamespaceTypeId,
    name,
    namespace,
  } satisfies Namespace;
});
