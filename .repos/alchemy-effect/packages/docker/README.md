# @alchemy.run/docker

Docker for [Alchemy](https://alchemy.run). Declare images, containers, networks, and volumes as typed resources, driven through your active Docker context. Other Alchemy providers use it to build and push the images they deploy.

```sh
npm install alchemy @alchemy.run/docker effect
```

A local Postgres with a generated password, a network, and a data volume:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.merge(Docker.providers(), Alchemy.RandomProvider()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const password = yield* Alchemy.makeRandom("PostgresPassword", { bytes: 16 });
    const image = yield* Docker.RemoteImage("Postgres", { name: "postgres", tag: "18-alpine" });
    const network = yield* Docker.Network("Network");
    const data = yield* Docker.Volume("Data");

    const postgres = yield* Docker.Container("Db", {
      image,
      environment: { POSTGRES_PASSWORD: password },
      ports: [{ external: 15432, internal: 5432 }],
      volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql/data" }],
      networks: [{ name: network.name, aliases: ["postgres"] }],
      start: true,
    });

    return { container: postgres.name };
  }),
);
```

`alchemy deploy` pulls the image and starts the container. Change a prop and the next deploy replaces only what changed; `alchemy destroy` removes all of it.

## Learn more

- [Docker on alchemy.run](https://alchemy.run/docker)
- [Setup](https://alchemy.run/docker/setup)
- [Build and push images](https://alchemy.run/docker/build-and-push)
- [API reference](https://alchemy.run/providers)
