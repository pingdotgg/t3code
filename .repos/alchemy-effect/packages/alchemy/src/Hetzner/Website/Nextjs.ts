import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The framework-integration module that drives `next build` plus a Node
 * `next({ dev: false })` serve entry. This module IS the Node pipeline
 * (not OpenNext).
 */
export const NEXTJS_NODE_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/nextjs/node";

export interface NextjsProps extends FrameworkSiteProps {}

/**
 * Deploy a Next.js application to a Hetzner Cloud Server: `next build`
 * then a long-running `next({ dev: false })` systemd unit on port 3000.
 * Does **not** use OpenNext (those wrappers are Lambda/workerd).
 *
 * The `.next` output (and `public/` when present) is packed into the
 * unit archive. `next`, `react`, and `react-dom` are installed on the
 * unit with `npm install` rather than bundled.
 *
 * During `alchemy dev` the site is `next dev` and no cloud resources
 * are declared; `Alchemy.remote()` opts back into the live Service.
 *
 *
 * ### Creating Next.js Sites
 * **Example:** Basic Next.js App
 * ```typescript
 * const site = yield* Hetzner.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Nextjs = (id: string, props: NextjsProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Nextjs",
    framework: NEXTJS_NODE_FRAMEWORK_SPECIFIER,
    target: NEXTJS_NODE_FRAMEWORK_SPECIFIER,
    skipClientAssets: true,
    install: ["next", "react", "react-dom"],
  }).pipe(Namespace.push(id));
