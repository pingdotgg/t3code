import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import * as CoreBinding from "../../Binding.ts";
import { taggedFunction } from "../../Util/effect.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";

/**
 * A Cloudflare **Worker-only binding** — the plain data value produced by
 * calling a {@link Service} (e.g. `Cloudflare.Images.Images(name)`).
 *
 * These bindings (`Browser`, `Images`, `VersionMetadata`, `RateLimit`,
 * `Artifacts.Namespace`, …) have **no backing cloud resource**; they are only
 * configuration on a Worker's script metadata. A binding value is therefore
 * both:
 *
 * - **declarable on a Worker's `env`** — `InferEnv` maps the per-binding type to
 *   its native runtime type, and {@link bindWorkerAsyncBindings} emits its wire
 *   spec via {@link toWorkerBinding}, and
 * - **`yield*`-able inside an Effect-native Worker** — its iterator attaches the
 *   binding to the surrounding Worker and resolves to the runtime client.
 */
export interface Binding<
  Kind extends string = string,
  Client = unknown,
  Service = unknown,
> {
  readonly kind: Kind;
  /** Binding name; the object key when declared on `env`. */
  readonly name: string;
  /** Attach the binding to the surrounding Worker and resolve to the client. */
  asEffect(): Effect.Effect<Client, never, Service>;
  [Symbol.iterator](): Generator<Effect.Effect<Client, never, Service>, Client>;
  /** Wire metadata emitted into the Worker script's `metadata.bindings`. */
  toWorkerBinding(): WorkerBinding;
}

/**
 * The fused tag + callable + type for a Worker-only binding — the same
 * single-identifier shape as core {@link CoreBinding.Service}, specialized so
 * the callable produces a {@link Binding} value instead of binding a resource.
 *
 * `interface X extends Binding.Service<X, Id, Client>` declares the type;
 * `const X = Binding.Service<X>({ … })` produces the value that is at once the
 * Context tag (usable in `Layer.effect(X, …)` / `Effect.provide`), the callable
 * (`X(props)` → a {@link Binding}), and carries the type.
 *
 * ```ts
 * import * as Binding from "../Workers/Binding.ts";
 *
 * export interface Images extends Binding.Service<Images, typeof Id, Client> {
 *   (props?: ImagesProps): Binding.Binding<typeof Id, Client, Images>;
 * }
 *
 * export const Images = Binding.Service<Images>({
 *   id: Id,
 *   defaultName: "IMAGES",
 *   toWorkerBinding: (b) => ({ type: "images", name: b.name }),
 * });
 * ```
 */
export interface Service<
  Self,
  Id extends string,
  Client,
> extends CoreBinding.Service<
  Self,
  Id,
  (binding: Binding<Id, Client, Self>) => Effect.Effect<Client>
> {}

type AnyService = { readonly key: string } & ((...args: any[]) => any);

/**
 * Build the fused tag + callable value for a Worker-only binding.
 *
 * `Self` (the per-binding interface) supplies the tag `id` (`Self["key"]`); the
 * binding's `Payload` (extra fields beyond `name`, e.g. RateLimit's
 * `namespaceId`/`simple`) is inferred from `parse`. Omit `parse` for name-only
 * bindings — `name` is read from the first arg's `.name` property.
 */
export const Service = <
  Self extends AnyService,
  Payload extends object = Record<never, never>,
>(config: {
  /** Tag key + binding `kind` (one identifier for both). */
  readonly id: Self["key"] & string;
  /** Default binding name when `props` omits one. */
  readonly defaultName: string;
  /**
   * Derive `name` + payload from the constructor args. Omit for name-only
   * bindings — `name` is then the first (string) arg, the binding's logical id.
   */
  readonly parse?: (...args: any[]) => { name?: string } & Payload;
  /** Build the wire binding spec from the resolved binding value. */
  readonly toWorkerBinding: (
    binding: { readonly name: string } & Payload,
  ) => WorkerBinding;
}): Self => {
  const tag = CoreBinding.Service<Self & { kind: "Service"; key: string }>(
    config.id as never,
  );
  const bind = tag as unknown as (binding: unknown) => Effect.Effect<unknown>;

  const construct = (...args: unknown[]) => {
    const { name, ...payload } =
      config.parse?.(...args) ??
      ({ name: args[0] as string | undefined } as {
        name?: string;
      } & Payload);
    const self: Record<PropertyKey, unknown> = {
      kind: config.id,
      name: name ?? config.defaultName,
      ...payload,
    };
    self.toWorkerBinding = () =>
      config.toWorkerBinding(self as { name: string } & Payload);
    self.asEffect = () => bind(self);
    self[Symbol.iterator] = () => new SingleShotGen(bind(self));
    return self;
  };

  return taggedFunction(tag as never, construct as never) as unknown as Self;
};

/** Structural guard for any Worker-only {@link Binding}. */
export const isBinding = (value: unknown): value is Binding =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  typeof (value as { toWorkerBinding?: unknown }).toWorkerBinding ===
    "function" &&
  typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
    "function";
