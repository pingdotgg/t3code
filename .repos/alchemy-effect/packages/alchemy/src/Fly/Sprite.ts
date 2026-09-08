import type {
  Sprite as FlySprite,
  UrlAuth as FlyUrlAuth,
} from "@distilled.cloud/fly-io/sprites";
import * as sprites from "@distilled.cloud/fly-io/sprites";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { isResolved } from "../Diff.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource, ResourceBinding } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { createInternalTags } from "../Tags.ts";
import {
  createFlyResourceName,
  matchesAlchemyPhysicalName,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import {
  createFlyHostRuntimeContext,
  createSpriteHostedSupport,
  DEFAULT_PORT,
  type FlyHostRuntimeContext,
  type HostedProgramProps,
} from "./hosted.ts";

const DEFAULT_URL_AUTH: UrlAuth = "public";
const APP_DIR = "/home/sprite/alchemy";
const BUN_BIN = "/home/sprite/.bun/bin/bun";
const SERVICE_NAME = "alchemy";
const OWNER_LABEL = "alchemy.type=Fly.Sprite";

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

export type UrlAuth = "public" | "sprite";

export type SpriteStatus = "cold" | "warm" | "running";

export interface SpriteProps extends PlatformProps {
  /**
   * Module entrypoint bundled with rolldown and written onto the Sprite.
   * Typically `import.meta.url`. A content-hash change updates in place.
   */
  main: string;
  /**
   * Sprite name. Unique per organization. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces
   * the Sprite.
   */
  name?: string;
  /**
   * Who can hit {@link Sprite} `url`. `public` is open. `sprite` requires
   * Sprites auth.
   *
   * @default "public"
   */
  urlAuth?: UrlAuth;
  /**
   * Port the hosted HTTP server listens on. Written to `PORT` and used
   * as the Sprite service `http_port`.
   *
   * @default 3000
   */
  port?: number;
  /**
   * Named export to load from `main`.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Additional environment variables for the hosted process. Merged
   * after binding-injected `env`.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output`
   * overrides plus pure-annotation options (`pure`).
   */
  build?: Bundle.BundleConfig;
}

/**
 * Binding contract accepted by {@link Sprite} for injected env.
 */
export interface SpriteBinding {
  env?: Record<string, any>;
}

export type Sprite = Resource<
  "Fly.Sprite",
  SpriteProps,
  {
    /** Fly Sprite id. */
    spriteId: string;
    /** Physical Sprite name (unique per org). */
    name: string;
    /**
     * Public Sprite URL (`https://{name}-….sprites.app`).
     */
    url: string;
    /** Observed runtime status. Hibernates to `cold` when idle. */
    status: SpriteStatus;
    /** Observed URL auth setting. */
    urlAuth: UrlAuth;
    /** Organization slug, if the API returned one. */
    orgSlug: string | undefined;
    /** Content hash of the bundled program. */
    code: {
      hash: string;
    };
  },
  SpriteBinding,
  Providers
>;

export const isSprite = (value: unknown): value is Sprite =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Fly.Sprite";

export type SpriteServices = ServerHost;

export type SpriteShape = Main<SpriteServices>;

export type SpriteRuntimeContext = FlyHostRuntimeContext;

/**
 * A Sprite is an Effect program running in a Fly.io Sprite. Sprites
 * are org-scoped Linux sandboxes. They hibernate when idle and wake
 * on demand. There is no parent {@link App}. Unlike a {@link Service},
 * Alchemy does not build a Docker image.
 *
 * @see https://sprites.dev/api/sprites
 *
 * ### Declare a Sprite
 * A Sprite is a class. Props describe the sandbox. The Effect is the
 * program that runs on it. There is no parent App.
 *
 * `main: import.meta.url` is the bundle entrypoint. Alchemy bundles
 * this file with Rolldown, writes it onto the Sprite, and runs it as
 * a Sprite service on {@link port}. Auth is `FLY_API_TOKEN`.
 *
 * **Example:** Class + main
 * ```typescript
 * export default class Box extends Fly.Sprite<Box>()(
 *   "Box",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * ) {}
 * ```
 *
 * ### Serve HTTP with fetch
 * Return `fetch` from the init Effect to boot an HTTP server. The
 * Sprite URL proxies to {@link port}.
 *
 * **Example:** Hello
 * ```typescript
 * export default class Box extends Fly.Sprite<Box>()(
 *   "Box",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### The public URL
 * Yield the Sprite in the Stack. `box.url` is
 * `https://{name}-….sprites.app`.
 *
 * **Example:** Stack output
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Fly.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const box = yield* Box;
 *     return { url: box.url };
 *   }),
 * );
 * ```
 *
 * ### URL auth
 * `urlAuth` is `public` or `sprite`. Default is `public` so `url`
 * answers without a Sprites token.
 *
 * **Example:** Sprite-auth URL
 * ```typescript
 * export default class Box extends Fly.Sprite<Box>()(
 *   "Box",
 *   { main: import.meta.url, urlAuth: "sprite" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::note[Default is public]
 * Fly's API default is `sprite`. Alchemy defaults to `public` so a
 * `fetch` handler is reachable.
 * :::
 *
 * ### Config
 * Yield `Config` in init. Alchemy reads the value from the env of
 * whoever deploys and writes it onto the Sprite. Do not pass
 * `env: { ... }` on a Sprite.
 *
 * Yield `FileSystem.FileSystem` in init, never inside `fetch`.
 *
 * **Example:** Config.redacted
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as FileSystem from "effect/FileSystem";
 * import * as Redacted from "effect/Redacted";
 *
 * export default class Box extends Fly.Sprite<Box>()(
 *   "Box",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.redacted("API_KEY");
 *     const fs = yield* FileSystem.FileSystem;
 *     yield* fs.makeDirectory("/tmp", { recursive: true });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const token = Redacted.value(apiKey);
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Exec
 * {@link Exec} runs a command on the Sprite. Provide {@link ExecHttp}.
 *
 * **Example:** ls
 * ```typescript
 * const exec = yield* Fly.Exec(Box);
 * const result = yield* exec({ cmd: ["ls", "-la"] });
 * ```
 *
 * ### Checkpoint
 * {@link Checkpoint} snapshots and restores the Sprite disk. Provide
 * {@link CheckpointHttp}.
 *
 * **Example:** Create and restore
 * ```typescript
 * const checkpoint = yield* Fly.Checkpoint(Box);
 * yield* checkpoint.create({ comment: "before" });
 * yield* checkpoint.restore("v1");
 * ```
 *
 * :::caution[Restore is destructive]
 * The disk rewinds. Later writes are gone.
 * :::
 *
 * ### A stable name
 * Omit `name` and Alchemy generates one from the stack, stage, and
 * logical ID.
 *
 * **Example:** Explicit name
 * ```typescript
 * export default class Box extends Fly.Sprite<Box>()(
 *   "Box",
 *   { main: import.meta.url, name: "box" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::caution[Changing `name` replaces the Sprite]
 * Fly cannot rename a Sprite. Alchemy creates the new name, then
 * deletes the old one.
 * :::
 *
 * ### Named export
 * `handler` is the named export to load from `main`. Default is
 * `"default"`.
 *
 * **Example:** Custom handler
 * ```typescript
 * export default class Box extends Fly.Sprite<Box>()(
 *   "Box",
 *   { main: import.meta.url, handler: "box" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @resource
 */
export const Sprite: Platform<
  Sprite,
  SpriteServices,
  SpriteShape,
  SpriteRuntimeContext
> = Platform("Fly.Sprite", {
  createRuntimeContext: createFlyHostRuntimeContext("Fly.Sprite"),
});

export class SpriteNotCreated extends Data.TaggedError("Fly.SpriteNotCreated")<{
  name: string;
}> {}

export class SpriteExecFailed extends Data.TaggedError("Fly.SpriteExecFailed")<{
  name: string;
  cmd: string;
  exitCode: number | undefined;
  stderr: string | undefined;
}> {}

class SpritePending extends Data.TaggedError("Fly.SpritePending")<{
  name: string;
}> {}

const toStatus = (status: string | undefined): SpriteStatus =>
  status === "warm" || status === "running" || status === "cold"
    ? status
    : "cold";

const toUrlAuth = (auth: string | undefined): UrlAuth =>
  auth === "sprite" ? "sprite" : "public";

const toAttrs = (
  sprite: FlySprite,
  name: string,
  codeHash: string,
): Sprite["Attributes"] => ({
  spriteId: sprite.id ?? name,
  name: sprite.name ?? name,
  url: sprite.url ?? `https://${name}.sprites.app`,
  status: toStatus(sprite.status),
  urlAuth: toUrlAuth(sprite.url_settings?.auth),
  orgSlug: sprite.org_slug ?? sprite.organization,
  code: { hash: codeHash },
});

const isOwnedSprite = (sprite: FlySprite): boolean => {
  const labels = sprite.labels ?? [];
  if (labels.includes(OWNER_LABEL)) return true;
  if (labels.some((label) => label.startsWith("alchemy.type="))) return true;
  return matchesAlchemyPhysicalName(sprite.name);
};

const resolveSpriteName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyAppName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyResourceName(id);
  });

const ownershipLabels = (id: string) =>
  Effect.gen(function* () {
    const tags = yield* createInternalTags(id);
    return [
      ...Object.entries(tags).map(([key, value]) => `${key}=${value}`),
      OWNER_LABEL,
    ];
  });

const getByName = (name: string) =>
  sprites
    .getSprite({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitForSprite = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((found) =>
      found !== undefined
        ? Effect.succeed(found)
        : Effect.fail(new SpritePending({ name })),
    ),
    Effect.retry({
      while: (e) => e._tag === "Fly.SpritePending",
      times: 8,
      schedule: backoff,
    }),
  );

const isTransient = (e: { readonly _tag: string }) =>
  e._tag === "NotFound" ||
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout";

const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isTransient,
      times: 8,
      schedule: backoff,
    }),
  );

const toEnv = (env: Record<string, any> | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).flatMap(([key, value]) => {
      if (value === undefined || value === null) return [];
      const raw = Redacted.isRedacted(value) ? Redacted.value(value) : value;
      return [[key, String(raw)]];
    }),
  );

const collectBindingEnv = (
  bindings: readonly ResourceBinding<SpriteBinding>[],
) => {
  const active = bindings.filter(
    (binding: ResourceBinding<SpriteBinding> & { action?: string }) =>
      binding.action !== "delete",
  );
  return active
    .map((binding) => binding?.data?.env)
    .reduce<Record<string, any>>((acc, value) => ({ ...acc, ...value }), {});
};

const desiredEnv = (
  props: SpriteProps,
  bindingEnv: Record<string, any>,
  alchemyEnv: Record<string, string>,
  port: number,
): Record<string, string> => ({
  ...toEnv(bindingEnv),
  ...alchemyEnv,
  PORT: String(port),
  ...toEnv(props.env),
});

const renderEnvFile = (env: Record<string, string>) =>
  `${Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;

const writeRemoteFile = (input: {
  name: string;
  path: string;
  body: Uint8Array;
}) =>
  retryTransient(
    sprites.writeFile({
      name: input.name,
      path: input.path,
      workingDir: "/",
      mkdir: true,
      body: input.body,
    }),
  );

const runExec = (input: { name: string; cmd: string[]; env?: string[] }) =>
  Effect.gen(function* () {
    const result = yield* retryTransient(
      sprites.execCommand({
        name: input.name,
        cmd: input.cmd,
        env: input.env,
      }),
    );
    if ((result.exit_code ?? 0) !== 0) {
      return yield* new SpriteExecFailed({
        name: input.name,
        cmd: input.cmd.join(" "),
        exitCode: result.exit_code,
        stderr: result.stderr,
      });
    }
    return result;
  });

const ensureBun = (name: string) =>
  runExec({
    name,
    cmd: [
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        "export HOME=/home/sprite",
        "export BUN_INSTALL=/home/sprite/.bun",
        'export PATH="$BUN_INSTALL/bin:$PATH"',
        'if [ ! -x "$BUN_INSTALL/bin/bun" ]; then',
        "  curl -fsSL https://bun.sh/install | bash",
        "fi",
        `test -x ${BUN_BIN}`,
      ].join("\n"),
    ],
  });

const putAlchemyService = (input: { name: string; port: number }) =>
  retryTransient(
    sprites.putService({
      name: input.name,
      service_name: SERVICE_NAME,
      cmd: "bash",
      args: [
        "-lc",
        `set -a; [ -f ${APP_DIR}/env ] && . ${APP_DIR}/env; set +a; exec ${BUN_BIN} --no-install ${APP_DIR}/index.mjs`,
      ],
      dir: APP_DIR,
      http_port: input.port,
    }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.void));

const deployProgram = Effect.fn(function* (input: {
  name: string;
  files: ReadonlyArray<{ path: string; content: Uint8Array }>;
  env: Record<string, string>;
  port: number;
  session?: { note: (message: string) => Effect.Effect<void> };
}) {
  const note = input.session?.note ?? ((_message: string) => Effect.void);
  yield* note(`Writing ${input.name} program onto the Sprite...`);
  for (const file of input.files) {
    const rel = file.path.replace(/^\/+/, "");
    yield* writeRemoteFile({
      name: input.name,
      path: `${APP_DIR}/${rel}`,
      body: file.content,
    });
  }
  yield* writeRemoteFile({
    name: input.name,
    path: `${APP_DIR}/env`,
    body: new TextEncoder().encode(renderEnvFile(input.env)),
  });
  yield* note(`Installing bun on ${input.name}...`);
  yield* ensureBun(input.name);
  yield* note(`Starting ${input.name} service...`);
  yield* putAlchemyService({ name: input.name, port: input.port });
});

export const SpriteProvider = () =>
  Provider.effect(
    Sprite,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const hosted = createSpriteHostedSupport({
        stackName: stack.name,
        stage: stack.stage,
        virtualEntryPlugin,
      });

      return Sprite.Provider.of({
        stables: ["spriteId", "name"],

        diff: Effect.fn(function* ({ news, output }) {
          if (news === undefined || output === undefined) return undefined;
          if (isResolved(news)) {
            const desiredName =
              news.name !== undefined
                ? sanitizeFlyAppName(news.name)
                : output.name;
            if (desiredName !== output.name) {
              return { action: "replace" as const };
            }
            const desiredAuth = news.urlAuth ?? DEFAULT_URL_AUTH;
            if (desiredAuth !== output.urlAuth) {
              return { action: "update" as const };
            }
          }
          // The code hash depends only on statically-known props — never
          // gate it on the WHOLE props being resolved: an unresolved
          // reference elsewhere in props would make code-only changes
          // silently noop (see the same pattern in Service.ts). By diff
          // time the effect-config form has been evaluated, so the object
          // view is safe to read.
          const statics = news as Partial<Pick<SpriteProps, "main" | "port">>;
          if (isResolved({ main: statics.main, port: statics.port })) {
            const hash = yield* hosted.hash(news as HostedProgramProps);
            if (hash !== output.code.hash) {
              return { action: "update" as const };
            }
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = yield* resolveSpriteName(id, olds?.name, output?.name);
          const found = yield* (
            output?.name !== undefined
              ? getByName(output.name)
              : Effect.succeed(undefined)
          ).pipe(
            Effect.flatMap((existing) =>
              existing !== undefined
                ? Effect.succeed(existing)
                : getByName(name),
            ),
            Effect.catchTag("SpritesNotEnabled", () =>
              Effect.succeed(undefined),
            ),
          );
          if (found === undefined) return undefined;
          const attrs = toAttrs(found, name, output?.code.hash ?? "");
          if (output !== undefined) return attrs;
          return isOwnedSprite(found) ? attrs : Unowned(attrs);
        }),

        list: Effect.fn(function* () {
          const items = yield* sprites.listSprites
            .items({ max_results: 50 })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("SpritesNotEnabled", () => Effect.succeed([])),
            );
          return items
            .filter(isOwnedSprite)
            .map((sprite) => toAttrs(sprite, sprite.name ?? "", ""));
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const props = news;
          const name = yield* resolveSpriteName(id, props.name, output?.name);
          const urlAuth = props.urlAuth ?? DEFAULT_URL_AUTH;
          const port = props.port ?? DEFAULT_PORT;
          const labels = yield* ownershipLabels(id);
          const boundEnv = collectBindingEnv(bindings ?? []);
          const env = desiredEnv(props, boundEnv, hosted.alchemyEnv, port);

          let current =
            output?.name !== undefined
              ? yield* getByName(output.name)
              : undefined;
          if (current === undefined && output?.name !== name) {
            current = yield* getByName(name);
          }

          if (current === undefined) {
            yield* sprites
              .createSprite({
                name,
                url_settings: { auth: urlAuth },
                labels,
              })
              .pipe(Effect.catchTag("Conflict", () => Effect.void));
            current = yield* waitForSprite(name).pipe(
              Effect.catchTag("Fly.SpritePending", () => getByName(name)),
            );
          }

          if (current === undefined) {
            return yield* new SpriteNotCreated({ name });
          }
          // Narrowed once so the `NotFound` fallbacks below keep the
          // non-optional type instead of widening back to `| undefined`.
          let sprite = current;

          const observedAuth = toUrlAuth(sprite.url_settings?.auth);
          if (observedAuth !== urlAuth) {
            sprite = yield* sprites
              .updateSprite({
                name,
                url_settings: { auth: urlAuth },
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed(sprite)));
          }

          const codeHash = yield* hosted.hash(props);
          if (codeHash !== output?.code.hash) {
            const bundled = yield* hosted.bundleProgram(props);
            yield* deployProgram({
              name,
              files: bundled.files,
              env,
              port,
              session,
            });
            sprite = (yield* getByName(name)) ?? sprite;
          }

          return toAttrs(sprite, name, codeHash);
        }),

        delete: Effect.fn(function* ({ output }) {
          if (output.name.length === 0) return;
          yield* sprites
            .deleteSprite({ name: output.name })
            .pipe(
              Effect.catchTag(
                ["NotFound", "SpritesNotEnabled"],
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
