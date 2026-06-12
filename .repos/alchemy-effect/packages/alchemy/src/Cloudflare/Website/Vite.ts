import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Build/Memo.ts";
import type { InputProps } from "../../Input.ts";
import {
  Worker,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface ViteProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<WorkerProps<Bindings>, "vite" | "main"> {
  /**
   * Root directory passed to Vite's `root` option.
   * Defaults to the current working directory (`process.cwd()`).
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether a rebuild is needed.
   * By default every non-gitignored file in `cwd` is hashed, plus the nearest
   * lockfile. Provide explicit globs to narrow the scope.
   *
   * @see {@link MemoOptions}
   */
  memo?: MemoOptions;
}

/**
 * A Cloudflare Worker deployed from a Vite project.
 *
 * `Vite` uses the Cloudflare Vite plugin to build both the server bundle
 * and client assets in a single `vite build` invocation — no manual
 * `main` entrypoint, build command, output directory, or Wrangler
 * configuration required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * @resource
 *
 * @section Deploying a Static Site
 * For a pure static site (no SSR), a single call is all you need.
 * Vite builds the project and Alchemy deploys the output as a
 * Cloudflare Worker with static assets.
 *
 * @example Static Vite site
 * ```typescript
 * const site = yield* Cloudflare.Vite("Website");
 * ```
 *
 * @section SSR Frameworks
 * For SSR frameworks like TanStack Start, SolidStart, or Nuxt, enable
 * `nodejs_compat` so the server bundle can use Node.js APIs.
 *
 * @example TanStack Start
 * ```typescript
 * const app = yield* Cloudflare.Vite("TanStackStart", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 * });
 * ```
 *
 * @example SolidStart with worker-first routing
 * ```typescript
 * const app = yield* Cloudflare.Vite("SolidStart", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 *   assets: {
 *     config: { runWorkerFirst: true },
 *   },
 * });
 * ```
 *
 * @section Single-Page Applications
 * For SPAs (React, Vue, etc.), configure asset handling so all
 * routes fall back to `index.html`.
 *
 * @example Vue SPA
 * ```typescript
 * const app = yield* Cloudflare.Vite("Vue", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 *   assets: {
 *     config: {
 *       htmlHandling: "auto-trailing-slash",
 *       notFoundHandling: "single-page-application",
 *     },
 *   },
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether
 * a rebuild is needed. Use `memo` to narrow the scope when your
 * project has large directories that don't affect the build output.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Vite("Docs", {
 *   memo: {
 *     include: ["src/**", "content/**", "package.json"],
 *   },
 * });
 * ```
 */
export const Vite = <
  const Bindings extends WorkerBindingProps = {},
  Req = never,
>(
  id: string,
  propsEff?:
    | InputProps<ViteProps<Bindings>>
    | Effect.Effect<InputProps<ViteProps<Bindings>>, never, Req>,
) =>
  Worker<Bindings, WorkerAssetsConfig, Req>(
    id,
    Effect.map(
      Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
      (props) => ({
        ...props,
        main: undefined!,
        vite: {
          rootDir: props?.rootDir,
          memo: props?.memo,
        },
      }),
    ),
  );
