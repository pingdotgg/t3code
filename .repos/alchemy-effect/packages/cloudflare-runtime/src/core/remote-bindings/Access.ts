import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";

export class Access extends Context.Service<
  Access,
  {
    readonly getAccessHeaders: (
      domain: string,
    ) => Effect.Effect<Record<string, string>, ConfigError | SystemError>;
  }
>()("cloudflare-runtime/remote-bindings/Access") {}

export const layer = Layer.effect(
  Access,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const usesAccessCache = yield* Cache.make({
      // Intentional: probe failures (timeout, DNS, network blip) are coerced
      // to "domain does not use Access" so we don't pop a login prompt for
      // every transient hiccup. This mirrors workers-sdk's behavior.
      lookup: (domain: string) =>
        Effect.promise((signal) =>
          fetch(`https://${domain}`, { redirect: "manual", signal }),
        ).pipe(
          Effect.map(
            (response) =>
              response.status === 302 &&
              (response.headers
                .get("location")
                ?.includes("cloudflareaccess.com") ??
                false),
          ),
          Effect.timeout(1000),
          Effect.orElseSucceed(() => false),
        ),
      capacity: Infinity,
    });
    const login = (domain: string) =>
      ChildProcess.make("cloudflared", ["access", "login", domain]).pipe(
        spawner.spawn,
        Effect.flatMap((process) => Stream.runCollect(process.stdout)),
        Effect.mapError(
          (error) =>
            new SystemError({
              subtag: "CloudflaredMissing",
              message: `The domain "${domain}" uses Cloudflare Access but the \`cloudflared\` CLI could not be invoked.`,
              hint: "Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation, or set CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET.",
              cause: error,
            }),
        ),
        Effect.flatMap((stdout) => {
          const matches = stdout
            .toString()
            .match(/fetched your token:\n\n(.*)/m);
          return matches && matches.length >= 2
            ? Effect.succeed({ Cookie: `CF_Authorization=${matches[1]}` })
            : Effect.fail(
                new SystemError({
                  subtag: "CloudflaredAuth",
                  message:
                    "Failed to extract a token from `cloudflared access login`.",
                  hint: "Try running `cloudflared access login <domain>` manually to debug.",
                  detail: { stdout: stdout.toString() },
                }),
              );
        }),
        Effect.scoped,
      );

    const getEnv = (name: string) =>
      Config.string(name).pipe(
        Effect.catchTag("ConfigError", () => Effect.succeed(undefined)),
      );

    return Access.of({
      getAccessHeaders: Effect.fn(function* (domain) {
        const domainUsesAccess = yield* Cache.get(usesAccessCache, domain);
        if (!domainUsesAccess) {
          return {};
        }
        const clientId = yield* getEnv("CLOUDFLARE_ACCESS_CLIENT_ID");
        const clientSecret = yield* getEnv("CLOUDFLARE_ACCESS_CLIENT_SECRET");
        if (clientId && clientSecret) {
          return {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          } as Record<string, string>;
        }

        if (clientId !== undefined || clientSecret !== undefined) {
          return yield* Effect.fail(
            new ConfigError({
              subtag: "AccessTokenIncomplete",
              message:
                "Both CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET must be set to use Access service-token authentication.",
              hint: `Only ${
                clientId !== undefined
                  ? "CLOUDFLARE_ACCESS_CLIENT_ID"
                  : "CLOUDFLARE_ACCESS_CLIENT_SECRET"
              } was found. Set the missing variable, unset both to fall back to interactive login, or remove the value to disable service-token auth.`,
            }),
          );
        }

        return yield* login(domain);
      }),
    });
  }),
);
