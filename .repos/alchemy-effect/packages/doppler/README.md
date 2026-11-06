# @alchemy.run/doppler

[Doppler](https://www.doppler.com) secrets for [Alchemy](https://alchemy.run). Load a Doppler config into your Stack: browser login on your machine, a service token in CI, and nothing written to `process.env` or disk.

```sh
npm install alchemy @alchemy.run/doppler effect
```

Pick the config per stage, then read secrets with Effect `Config`:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Doppler from "@alchemy.run/doppler";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
    state: Alchemy.localState(),
    secrets: [
      Doppler.Secrets(({ stage }) => ({
        project: "my-app",
        config: stage === "prod" ? "prd" : "dev",
      })),
    ],
  },
  Effect.gen(function* () {
    const databaseUrl = yield* Config.Redacted("DATABASE_URL");
    return {};
  }),
);
```

Connect your account once with `alchemy profile edit --add Doppler`.

## Learn more

- [Doppler on alchemy.run](https://alchemy.run/environments/doppler)
- [Secret providers](https://alchemy.run/environments/secret-providers)
- [Secrets](https://alchemy.run/environments/secrets)
