import { PkgRegistry } from "@alchemy.run/pkg/Registry";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as ByteSize from "effect/ByteSize";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AlchemyPkg",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const registry = yield* PkgRegistry("Registry", {
      worker: {
        domain: {
          name: "pkg.alchemy.run",
          aliases: [
            "pkg.distilled.cloud",
            "📦.alchemy.run",
            "📦.distilled.cloud",
          ],
        },
      },
      github: {
        appId: Config.String("GH_APP_ID"),
        privateKey: Config.Redacted("GH_APP_PRIVATE_KEY"),
      },
      policy: {
        repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
        ttl: Duration.weeks(1),
        maxPackageSize: ByteSize.megabytes(100),
      },
    });

    return {
      url: registry.url.as<string>(),
    };
  }),
);
