# Docker PostgreSQL Example

This example provisions PostgreSQL 18 Alpine with Docker resources:

- `Docker.RemoteImage` pulls `postgres:18-alpine`
- `Docker.Network` creates an app network
- `Docker.Volume` creates persistent database storage
- `Docker.Container` starts PostgreSQL with a redacted password, a network alias, a named volume, and a host port
- `Docker.inspectContainer` returns the bound host port

Docker resources use the active Docker CLI context. That can be Docker Desktop, a remote Docker host, an SSH context, or a CI runner daemon.

These resources are separate from `Cloudflare.Container`. The bridge between Docker and cloud container platforms is an image reference or registry digest, not a swappable container object.

## Commands

```sh
bun install
POSTGRES_PASSWORD=change-me bun run --filter docker-postgres-example deploy
bun run --filter docker-postgres-example destroy
```

If `POSTGRES_PASSWORD` is omitted, the example generates and stores a redacted password with `Alchemy.makeRandom`.

The stack publishes PostgreSQL on `localhost:15432`:

```sh
psql postgres://alchemy:change-me@localhost:15432/app
```
