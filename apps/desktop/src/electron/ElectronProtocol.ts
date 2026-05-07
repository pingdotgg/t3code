import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import { DesktopEnvironment, type DesktopEnvironmentShape } from "../main/DesktopEnvironment.ts";

export const DESKTOP_SCHEME = "t3";

export interface ElectronProtocolShape {
  readonly registerDesktopSchemePrivileges: Effect.Effect<void>;
  readonly registerFileProtocol: <R>(input: {
    readonly scheme: string;
    readonly handler: (
      request: Electron.ProtocolRequest,
    ) => Effect.Effect<Electron.ProtocolResponse, unknown, R>;
    readonly onFailure?: (
      request: Electron.ProtocolRequest,
      cause: Cause.Cause<unknown>,
    ) => Electron.ProtocolResponse;
  }) => Effect.Effect<void, unknown, R | Scope.Scope>;
  readonly registerDesktopFileProtocol: Effect.Effect<
    void,
    unknown,
    FileSystem.FileSystem | DesktopEnvironment | Scope.Scope
  >;
}

export class ElectronProtocol extends Context.Service<ElectronProtocol, ElectronProtocolShape>()(
  "t3/desktop/electron/Protocol",
) {}

export function normalizeDesktopProtocolPathname(rawPath: string): Option.Option<string> {
  const segments: string[] = [];
  for (const segment of rawPath.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return Option.none();
    }
    segments.push(segment);
  }
  return Option.some(segments.join("/"));
}

const registerDesktopSchemePrivileges = Effect.sync(() => {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
});

const resolveDesktopStaticDir: Effect.Effect<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment;
  const candidates = [
    environment.path.join(environment.appRoot, "apps/server/dist/client"),
    environment.path.join(environment.appRoot, "apps/web/dist"),
  ];
  for (const candidate of candidates) {
    const hasIndex = yield* fileSystem
      .exists(environment.path.join(candidate, "index.html"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasIndex) {
      return Option.some(candidate);
    }
  }
  return Option.none<string>();
});

function resolveDesktopStaticPath(
  staticRoot: string,
  requestUrl: string,
): Effect.Effect<string, never, FileSystem.FileSystem | DesktopEnvironment> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const url = new URL(requestUrl);
    const rawPath = decodeURIComponent(url.pathname);
    const normalizedPath = normalizeDesktopProtocolPathname(rawPath);
    if (Option.isNone(normalizedPath)) {
      return environment.path.join(staticRoot, "index.html");
    }

    const requestedPath = normalizedPath.value.length > 0 ? normalizedPath.value : "index.html";
    const resolvedPath = environment.path.join(staticRoot, requestedPath);

    if (environment.path.extname(resolvedPath)) {
      return resolvedPath;
    }

    const nestedIndex = environment.path.join(resolvedPath, "index.html");
    const nestedIndexExists = yield* fileSystem
      .exists(nestedIndex)
      .pipe(Effect.orElseSucceed(() => false));
    if (nestedIndexExists) {
      return nestedIndex;
    }

    return environment.path.join(staticRoot, "index.html");
  });
}

function isStaticAssetRequest(requestUrl: string, environment: DesktopEnvironmentShape): boolean {
  try {
    const url = new URL(requestUrl);
    return environment.path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

const make = Effect.gen(function* () {
  const registeredProtocols = yield* Ref.make<ReadonlySet<string>>(new Set());

  const registerFileProtocol = <R>({
    scheme,
    handler,
    onFailure,
  }: {
    readonly scheme: string;
    readonly handler: (
      request: Electron.ProtocolRequest,
    ) => Effect.Effect<Electron.ProtocolResponse, unknown, R>;
    readonly onFailure?: (
      request: Electron.ProtocolRequest,
      cause: Cause.Cause<unknown>,
    ) => Electron.ProtocolResponse;
  }): Effect.Effect<void, unknown, R | Scope.Scope> =>
    Effect.gen(function* () {
      const alreadyRegistered = yield* Ref.get(registeredProtocols).pipe(
        Effect.map((protocols) => protocols.has(scheme)),
      );
      if (alreadyRegistered) {
        return;
      }

      const context = yield* Effect.context<R>();
      const runPromise = Effect.runPromiseWith(context);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const registered = Electron.protocol.registerFileProtocol(
              scheme,
              (request, callback) => {
                const response = handler(request).pipe(
                  Effect.catchCause((cause) =>
                    Effect.succeed(onFailure?.(request, cause) ?? ({ error: -2 } as const)),
                  ),
                );

                void runPromise(response).then(callback, () => callback({ error: -2 }));
              },
            );
            if (!registered) {
              throw new Error(`Failed to register ${scheme}: file protocol.`);
            }
          },
          catch: (error) => error,
        }).pipe(
          Effect.andThen(
            Ref.update(registeredProtocols, (protocols) => new Set(protocols).add(scheme)),
          ),
        ),
        () =>
          Effect.sync(() => {
            Electron.protocol.unregisterProtocol(scheme);
          }).pipe(
            Effect.andThen(
              Ref.update(registeredProtocols, (protocols) => {
                const next = new Set(protocols);
                next.delete(scheme);
                return next;
              }),
            ),
          ),
      );
    });

  const registerDesktopFileProtocol = Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    if (environment.isDevelopment) return;

    const staticRoot = yield* resolveDesktopStaticDir;
    if (Option.isNone(staticRoot)) {
      return yield* Effect.fail(
        new Error("Desktop static bundle missing. Build apps/server (with bundled client) first."),
      );
    }

    const staticRootResolved = environment.path.resolve(staticRoot.value);
    const staticRootPrefix = `${staticRootResolved}${environment.path.sep}`;
    const fallbackIndex = environment.path.join(staticRootResolved, "index.html");

    yield* registerFileProtocol({
      scheme: DESKTOP_SCHEME,
      handler: (request) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const environment = yield* DesktopEnvironment;
          const candidate = yield* resolveDesktopStaticPath(staticRootResolved, request.url);
          const resolvedCandidate = environment.path.resolve(candidate);
          const isInRoot =
            resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
          const isAssetRequest = isStaticAssetRequest(request.url, environment);
          const exists = yield* fileSystem
            .exists(resolvedCandidate)
            .pipe(Effect.orElseSucceed(() => false));

          if (!isInRoot || !exists) {
            return isAssetRequest ? ({ error: -6 } as const) : ({ path: fallbackIndex } as const);
          }

          return { path: resolvedCandidate } as const;
        }),
      onFailure: () => ({ path: fallbackIndex }),
    });
  });

  return ElectronProtocol.of({
    registerDesktopSchemePrivileges,
    registerFileProtocol,
    registerDesktopFileProtocol,
  });
});

export const layer = Layer.effect(ElectronProtocol, make);
