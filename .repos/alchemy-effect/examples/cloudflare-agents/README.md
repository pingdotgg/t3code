# Cloudflare: Agents SDK

Deploys an app built on Cloudflare's [Agents SDK](https://developers.cloudflare.com/agents/)
with `Cloudflare.Website.Vite`. `vite.config.ts` is the Agents starter's,
unchanged: `agents()` compiles the `@callable()` decorators.

`src/server.ts` defines two agents, each a Durable Object declared in
`alchemy.run.ts`:

- `Counter`, a stateful `Agent`. Its state syncs to connected clients,
  `@callable()` methods run over its WebSocket, `schedule()` calls it back
  later, and `onRequest` answers plain HTTP. `routeAgentRequest` serves it at
  `/agents/counter/:name`, through the binding named after the class.
- `Calculator`, an `McpAgent` MCP server with an `add` tool, served at `/mcp`
  through the `MCP_OBJECT` binding `McpAgent.serve()` expects.

`src/client.tsx` is a React client that connects with `useAgent`.

## Deploy

```sh
bun run deploy
```

## Develop

```sh
bun run dev
```

## Destroy

```sh
bun run destroy
```
