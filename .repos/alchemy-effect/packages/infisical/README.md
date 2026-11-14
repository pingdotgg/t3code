# @alchemy.run/infisical

[Infisical](https://infisical.com) secrets for [Alchemy](https://alchemy.run). Load an Infisical environment into your Stack, with nothing written to `process.env` or disk.

```sh
npm install alchemy @alchemy.run/infisical effect
```

Pick the environment per stage, then read secrets with Effect `Config`:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Infisical from "@alchemy.run/infisical";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
    state: Alchemy.localState(),
    secrets: [
      Infisical.Secrets(({ stage }) => ({
        project: "my-app",
        environment: stage === "prod" ? "prod" : "dev",
        path: "/api",
      })),
    ],
  },
  Effect.gen(function* () {
    const databaseUrl = yield* Config.Redacted("DATABASE_URL");
    return {};
  }),
);
```

Connect your account once with `alchemy profile edit --add Infisical`.

## Learn more

- [Infisical on alchemy.run](https://alchemy.run/environments/infisical)
- [Secret providers](https://alchemy.run/environments/secret-providers)
- [Secrets](https://alchemy.run/environments/secrets)
