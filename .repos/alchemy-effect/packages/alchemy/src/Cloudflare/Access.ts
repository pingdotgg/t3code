import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { cachedFunction } from "../Util/cached-function.ts";

export class AccessError extends Schema.TaggedErrorClass<AccessError>()(
  "AccessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class Access extends Context.Service<
  Access,
  {
    readonly getAccessHeaders: (
      domain: string,
    ) => Effect.Effect<Record<string, string>, AccessError>;
  }
>()("alchemy/Cloudflare/Access") {}

export const AccessLive = Layer.effect(
  Access,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const domainUsesAccess = yield* cachedFunction((domain: string) =>
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
        Effect.catch(() => Effect.succeed(false)),
      ),
    );
    const login = (domain: string) =>
      ChildProcess.make("cloudflared", ["access", "login", domain]).pipe(
        spawner.spawn,
        Effect.flatMap((process) => Stream.runCollect(process.stdout)),
        Effect.mapError(
          (error) =>
            new AccessError({
              message:
                `The domain "${domain}" uses Cloudflare Access, but \`cloudflared\` is not installed. ` +
                `Please install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation.`,
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
                new AccessError({
                  message: "Failed to authenticate with Cloudflare Access",
                }),
              );
        }),
        Effect.scoped,
      );

    const getEnv = (name: string) =>
      Config.string(name)

        .pipe(Effect.catchTag("ConfigError", () => Effect.succeed(undefined)));

    return Access.of({
      getAccessHeaders: Effect.fn(function* (domain) {
        if (!(yield* domainUsesAccess(domain))) {
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
          yield* Effect.logWarning(
            "Both CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET must be set to use Access Service Token authentication. " +
              `Only ${
                clientId !== undefined
                  ? "CLOUDFLARE_ACCESS_CLIENT_ID"
                  : "CLOUDFLARE_ACCESS_CLIENT_SECRET"
              } was found.`,
          );
        }

        return yield* login(domain);
      }),
    });
  }),
);
