import * as Effect from "effect/Effect";
import * as Namespace from "./Namespace.ts";

/**
 * Create a reusable construct that composes child resources under a shared
 * namespace.
 *
 * `Construct.fn` wraps a generator function and automatically pushes the
 * construct `id` onto the current namespace so nested resources become stable
 * children of the construct.
 *
 * @section Creating Constructs
 * @example Simple Reusable Construct
 * ```typescript
 * import * as Construct from "alchemy/Construct";
 * import { Bucket } from "alchemy/AWS/S3";
 *
 * export const Logs = Construct.fn(function* (
 *   id: string,
 *   props: { forceDestroy?: boolean },
 * ) {
 *   const bucket = yield* Bucket("Bucket", {
 *     forceDestroy: props.forceDestroy,
 *   });
 *
 *   return { bucket };
 * });
 * ```
 *
 * @example Composing Website Resources
 * ```typescript
 * export const App = Construct.fn(function* (
 *   id: string,
 *   props: { sourcePath: string },
 * ) {
 *   const site = yield* StaticSite("Web", {
 *     sourcePath: props.sourcePath,
 *     cdn: false,
 *   });
 *
 *   const router = yield* Router("Router", {
 *     routes: {
 *       "/*": site.routeTarget,
 *     },
 *   });
 *
 *   return { site, router };
 * });
 * ```
 */
export const fn: {
  <Eff extends Effect.Effect<any, any, any>, AEff, Props extends object>(
    body: (id: string, props: Props) => Generator<Eff, AEff, never>,
  ): (
    id: string,
    props: Props,
  ) => Effect.Effect<
    AEff,
    [Eff] extends [never]
      ? never
      : [Eff] extends [Effect.Effect<infer _A, infer E, infer _R>]
        ? E
        : never,
    [Eff] extends [never]
      ? never
      : [Eff] extends [Effect.Effect<infer _A, infer _E, infer R>]
        ? R
        : never
  >;
} = (body) => (id, props) =>
  Effect.gen(() => body(id, props)).pipe(Namespace.push(id));
