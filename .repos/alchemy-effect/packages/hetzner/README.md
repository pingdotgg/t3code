# @alchemy.run/hetzner

Hetzner Cloud for [Alchemy](https://alchemy.run). Declare Servers, volumes, networks, firewalls, load balancers, and DNS, and run Effect programs on those Servers, all in one TypeScript program.

```sh
npm install alchemy @alchemy.run/hetzner effect
```

A Server with a mounted volume, and a Service that runs on it:

```typescript
// src/api.ts
import * as Hetzner from "@alchemy.run/hetzner";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Box = Hetzner.Server("Box", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "nbg1",
});

export const Data = Hetzner.Volume("Data", {
  size: 10,
  format: "ext4",
  location: "nbg1",
});

export default class Api extends Hetzner.Service<Api>()(
  "Api",
  { server: Box, main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const mount = yield* Hetzner.MountVolume(yield* Data, { path: "/data" });

    return {
      fetch: HttpServerResponse.json({ volume: mount.path }),
    };
  }).pipe(Effect.provide(Hetzner.MountVolumeLive)),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Hetzner from "@alchemy.run/hetzner";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

`alchemy deploy` creates the Server and volume, copies the bundled program over SSH, and runs it as a systemd unit.

## Learn more

- [Hetzner on alchemy.run](https://alchemy.run/hetzner)
- [Setup](https://alchemy.run/hetzner/setup)
- [Tutorial](https://alchemy.run/hetzner/tutorial/part-1)
- [API reference](https://alchemy.run/providers)
