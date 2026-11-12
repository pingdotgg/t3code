/// <reference types="@astrojs/starlight/locals" />
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import type { StarlightRouteData } from "@astrojs/starlight/route-data";

/**
 * Starlight always emits a single `<link rel="shortcut icon">` from its
 * `favicon` config. Drop it so the per-theme set in `brand/Icons.astro`
 * (rendered by the `Head` override) is the only icon the browser sees.
 */
export const onRequest = defineRouteMiddleware((context) => {
  // `locals` isn't ambient-typed in this project (see docs-tabs-sidebar.ts).
  const { starlightRoute } = context.locals as { starlightRoute: StarlightRouteData };
  starlightRoute.head = starlightRoute.head.filter(
    (entry) => !(entry.tag === "link" && entry.attrs?.rel === "shortcut icon"),
  );
});
