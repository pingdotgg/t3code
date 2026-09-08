import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Waku build. */
export const WAKU_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/waku";

/** The Node container deploy target for the Waku build. */
export const WAKU_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/waku/node";

const wakuOptions = (props: WakuProps) =>
  props.waku !== undefined ? { waku: props.waku } : undefined;

export interface WakuProps extends FrameworkSiteProps {
  /**
   * Serializable Waku config merged OVER the project's own
   * `waku.config.*`.
   */
  waku?: {
    srcDir?: string;
    distDir?: string;
    basePath?: string;
  };
}

/**
 * Deploy a [Waku](https://waku.gg) application to Railway: the RSC server
 * plus SSG pages on one `Railway.Service`. The Node deploy target selects
 * waku's `node` adapter; do not set `unstable_adapter`. SSG pages are
 * served extensionless (`/about`).
 *
 * During `alchemy dev` the site is Waku's own dev server and no cloud
 * resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * ### Creating Waku Sites
 * **Example:** Basic Waku App
 * ```typescript
 * const site = yield* Railway.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Railway.Website.Waku("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Waku = (id: string, props: WakuProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Waku",
    framework: WAKU_FRAMEWORK_SPECIFIER,
    target: WAKU_NODE_TARGET_SPECIFIER,
    options: wakuOptions(props),
  }).pipe(Namespace.push(id));
