import type { PluginId } from "@t3tools/contracts/plugin";
import type { PluginHttpDescriptor } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export interface MatchedPluginHttpRoute {
  readonly descriptor: PluginHttpDescriptor;
  readonly params: Readonly<Record<string, string>>;
}

export class PluginHttpRegistry extends Context.Service<
  PluginHttpRegistry,
  {
    readonly put: (
      pluginId: PluginId,
      routes: ReadonlyArray<PluginHttpDescriptor>,
    ) => Effect.Effect<void>;
    readonly remove: (pluginId: PluginId) => Effect.Effect<void>;
    readonly match: (input: {
      readonly pluginId: PluginId;
      readonly method: string;
      readonly path: string;
    }) => Effect.Effect<Option.Option<MatchedPluginHttpRoute>>;
  }
>()("t3/plugins/PluginHttpRegistry") {}

const normalizePath = (path: string) => {
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/u, "") : "/";
};

const pathSegments = (path: string) =>
  normalizePath(path)
    .split("/")
    .filter((segment) => segment.length > 0);

const matchPath = (pattern: string, path: string): Readonly<Record<string, string>> | null => {
  const patternSegments = pathSegments(pattern);
  const requestSegments = pathSegments(path);
  if (patternSegments.length !== requestSegments.length) return null;

  // Null-prototype: a parameter named `__proto__` / `constructor` must land as an
  // own property, not walk into an inherited setter (which drops the value or
  // mutates the prototype).
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < patternSegments.length; index++) {
    const patternSegment = patternSegments[index];
    const requestSegment = requestSegments[index];
    if (patternSegment === undefined || requestSegment === undefined) return null;
    if (patternSegment.startsWith(":")) {
      const name = patternSegment.slice(1);
      if (name.length === 0) return null;
      // Malformed percent-escapes must not become route defects (public,
      // unauthenticated surface): an undecodable segment simply doesn't match.
      try {
        params[name] = decodeURIComponent(requestSegment);
      } catch {
        return null;
      }
      continue;
    }
    if (patternSegment !== requestSegment) return null;
  }
  return params;
};

export const make = Effect.fn("PluginHttpRegistry.make")(function* () {
  const routesRef = yield* Ref.make(new Map<PluginId, ReadonlyArray<PluginHttpDescriptor>>());

  return PluginHttpRegistry.of({
    put: (pluginId, routes) =>
      Ref.update(routesRef, (current) => {
        const next = new Map(current);
        next.set(pluginId, routes);
        return next;
      }),
    remove: (pluginId) =>
      Ref.update(routesRef, (current) => {
        const next = new Map(current);
        next.delete(pluginId);
        return next;
      }),
    match: ({ pluginId, method, path }) =>
      Ref.get(routesRef).pipe(
        Effect.map((routes) => {
          const normalizedMethod = method.toUpperCase();
          for (const descriptor of routes.get(pluginId) ?? []) {
            if (descriptor.method.toUpperCase() !== normalizedMethod) continue;
            const params = matchPath(descriptor.path, path);
            if (params) {
              return Option.some({ descriptor, params });
            }
          }
          return Option.none();
        }),
      ),
  });
});

export const layer = Layer.effect(PluginHttpRegistry, make());
