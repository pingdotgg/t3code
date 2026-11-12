# Cloudflare: Flue

Deploys a [Flue](https://flueframework.com) agent app to Cloudflare Workers
with `Cloudflare.Website.Vite`. `vite.config.ts` is Flue's documented
Cloudflare setup, unchanged:

```ts
plugins: [flue(), cloudflare({ config: flueWorkerConfig() })];
```

Alchemy builds and serves the Worker in place of `@cloudflare/vite-plugin`, so
the Worker settings Flue contributes through `flueWorkerConfig()` are declared
in `alchemy.run.ts` instead of `wrangler.jsonc`:

- `main: "virtual:flue/worker"`, Flue's generated Worker entry.
- The `nodejs_compat` flag and a compatibility date of 2026-04-01 or later.
- One Durable Object per `'use agent'` agent. The `Assistant` agent in
  `src/agents/assistant.ts` is the class `FlueAssistantAgent`, bound as
  `FLUE_ASSISTANT_AGENT`.
- The Workers AI binding (`AI`), which the agent's `cloudflare/...` model
  calls go through, so no provider API key is needed.

`src/app.ts` is the route map: a Hono app with `/api/ping` and the agent
mounted at `/agents/assistant`.

## Deploy

```sh
bun run deploy
```

Talk to the agent with `@flue/sdk`:

```ts
import { createFlueClient } from "@flue/sdk";

const client = createFlueClient({ url: `${url}/agents/assistant/demo-1` });
const admission = await client.send({ message: { kind: "user", body: "Hello!" } });
const { text } = await client.read(admission);
```

## Develop

```sh
bun run dev
```

## Destroy

```sh
bun run destroy
```
