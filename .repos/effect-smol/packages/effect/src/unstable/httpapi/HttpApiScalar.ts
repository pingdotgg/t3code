/**
 * Scalar documentation UI for declarative `HttpApi` contracts.
 *
 * Use this module to mount a browser-based API reference on an `HttpRouter`
 * without writing or storing a separate OpenAPI file. The route renders an HTML
 * page containing the OpenAPI document produced from the supplied `HttpApi` and
 * boots Scalar in the browser.
 *
 * ## Mental model
 *
 * {@link layer} serves the UI with the bundled Scalar script. {@link layerCdn}
 * serves the same UI while loading Scalar from jsDelivr, optionally pinned with
 * `version`. Both helpers register a `GET` route, defaulting to `/docs`, and
 * pass {@link ScalarConfig} through to Scalar's HTML configuration.
 *
 * ## Common tasks
 *
 * - Use {@link layer} when the application should serve the bundled Scalar
 *   assets without depending on a CDN at runtime.
 * - Use {@link layerCdn} when a CDN-loaded Scalar bundle is preferred, and pin
 *   `version` when repeatable output matters.
 * - Set `path` to mount the documentation UI somewhere other than `/docs`.
 * - Set `proxyUrl`, theme, layout, and `baseServerURL` in `ScalarConfig` for
 *   request testing, styling, and relative server URLs.
 *
 * ## Gotchas
 *
 * The mounted route is an HTML documentation page, not a raw OpenAPI JSON
 * endpoint. If clients, gateways, or documentation pipelines need the OpenAPI
 * document directly, expose it separately with `HttpApiBuilder.layer`'s
 * `openapiPath` option.
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as Layer from "../../Layer.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import type * as HttpApi from "./HttpApi.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import * as Html from "./internal/html.ts"
import * as internal from "./internal/httpApiScalar.ts"
import * as OpenApi from "./OpenApi.ts"

/**
 * Theme preset identifier accepted by the Scalar API reference UI.
 *
 * @category models
 * @since 4.0.0
 */
export type ScalarThemeId =
  | "alternate"
  | "default"
  | "moon"
  | "purple"
  | "solarized"
  | "bluePlanet"
  | "saturn"
  | "kepler"
  | "mars"
  | "deepSpace"
  | "laserwave"
  | "none"

/**
 * Configuration passed to the embedded Scalar API reference UI.
 *
 * **Details**
 *
 * This configuration follows Scalar's API reference configuration:
 * https://github.com/scalar/scalar/blob/main/documentation/configuration.md
 *
 * @category models
 * @since 4.0.0
 */
export type ScalarConfig = {
  /** A string to use one of the color presets */
  theme?: ScalarThemeId
  /** The layout to use for the references */
  layout?: "modern" | "classic"
  /** URL to a request proxy for the API client */
  proxyUrl?: string
  /** Whether to show the sidebar */
  showSidebar?: boolean
  /**
   * Whether to show models in the sidebar, search, and content.
   *
   * @default false
   */
  hideModels?: boolean
  /**
   * Whether to show the "Test Request" button.
   *
   * @default false
   */
  hideTestRequestButton?: boolean
  /**
   * Whether to show the sidebar search bar.
   *
   * @default false
   */
  hideSearch?: boolean
  /** Whether dark mode is on or off initially (light mode) */
  darkMode?: boolean
  /** forceDarkModeState makes it always this state no matter what */
  forceDarkModeState?: "dark" | "light"
  /** Whether to show the dark mode toggle */
  hideDarkModeToggle?: boolean
  /**
   * Path to a favicon image.
   *
   * **Example** (Relative favicon)
   *
   * ```ts
   * const favicon = "/favicon.svg"
   * ```
   *
   * @default undefined
   */
  favicon?: string
  /** Custom CSS to be added to the page */
  customCss?: string
  /**
   * Origin used when the OpenAPI document contains relative server URLs and is
   * rendered during SSR.
   *
   * **Details**
   *
   * Browsers can derive the origin from `window.location.origin`; server
   * rendering needs this value supplied explicitly.
   *
   * **Example** (Local server URL)
   *
   * ```ts
   * const baseServerURL = "http://localhost:3000"
   * ```
   *
   * @default undefined
   */
  baseServerURL?: string
  /**
   * Whether Scalar loads its default Inter and JetBrains Mono fonts.
   *
   * **Details**
   *
   * Set this to `false` when supplying custom fonts.
   *
   * @default true
   */
  withDefaultFonts?: boolean
  /**
   * Whether all tags are open by default instead of only the tag matching the
   * current URL.
   *
   * @default false
   */
  defaultOpenAllTags?: boolean
  /**
   * Whether to display the operation ID in the operation reference.
   *
   * @default false
   */
  showOperationId?: boolean
}

type ScalarSource =
  | {
    readonly _tag: "Cdn"
    readonly version?: string | undefined
  }
  | {
    readonly _tag: "Inline"
    readonly source: string
  }

const makeHandler = <Id extends string, Groups extends HttpApiGroup.Any>(options: {
  readonly api: HttpApi.HttpApi<Id, Groups>
  readonly source: ScalarSource
  readonly scalar: ScalarConfig | undefined
}) => {
  const spec = OpenApi.fromApi(options.api)
  const scalarConfig = {
    _integration: "html",
    ...options.scalar
  }
  const response = HttpServerResponse.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${Html.escape(spec.info.title)}</title>
    ${
    !spec.info.description
      ? ""
      : `<meta name="description" content="${Html.escape(spec.info.description)}"/>`
  }
    ${
    !spec.info.description
      ? ""
      : `<meta name="og:description" content="${Html.escape(spec.info.description)}"/>`
  }
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" type="application/json">
      ${Html.escapeJson(spec)}
    </script>
    <script>
      document.getElementById('api-reference').dataset.configuration = JSON.stringify(${Html.escapeJson(scalarConfig)})
    </script>
    ${
    options.source._tag === "Cdn"
      ? `<script src="${`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${
        options.source.version ?? "latest"
      }/dist/browser/standalone.min.js`}" crossorigin></script>`
      : `<script>${options.source.source}</script>`
  }
  </body>
</html>`)
  return Effect.succeed(response)
}

/**
 * Mounts a Scalar API reference page for an `HttpApi` using the bundled Scalar script.
 *
 * **Details**
 *
 * The route serves the OpenAPI specification generated from the API at the
 * configured path, defaulting to `/docs`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly path?: `/${string}` | undefined
    readonly scalar?: ScalarConfig
  } | undefined
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const handler = makeHandler({
      api,
      source: {
        _tag: "Inline",
        source: internal.javascript
      },
      scalar: options?.scalar
    })
    yield* router.add("GET", options?.path ?? "/docs", handler)
  }))

/**
 * Mounts a Scalar API reference page for an `HttpApi` that loads Scalar from jsDelivr.
 *
 * **Details**
 *
 * The route serves the OpenAPI specification generated from the API at the
 * configured path, defaulting to `/docs`; `version` selects the Scalar package
 * version loaded from the CDN.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerCdn = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly path?: `/${string}` | undefined
    readonly scalar?: ScalarConfig
    readonly version?: string | undefined
  } | undefined
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const handler = makeHandler({
      api,
      source: {
        _tag: "Cdn",
        version: options?.version
      },
      scalar: options?.scalar
    })
    yield* router.add("GET", options?.path ?? "/docs", handler)
  }))
