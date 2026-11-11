# Hyperdrive + Workers VPC + Aurora

[Guide](https://alchemy.run/cloudflare/data/hyperdrive-private-database/)

A Cloudflare Worker queries Aurora PostgreSQL in private AWS subnets through Hyperdrive. Nothing in the VPC accepts inbound traffic: `cloudflared` runs on ECS Fargate and dials out to Cloudflare.

```
Worker → Hyperdrive → VPC Service → Tunnel → cloudflared (ECS) → Aurora
```

- [src/Database.ts](./src/Database.ts) — VPC, security groups, Aurora
- [src/Connector.ts](./src/Connector.ts) — Cloudflare Tunnel + `cloudflared` on ECS
- [src/Hyperdrive.ts](./src/Hyperdrive.ts) — TCP VPC Service + Hyperdrive
- [src/worker.ts](./src/worker.ts) — the Worker

## Deploy

From the repository root:

```sh
pnpm install
cd examples/cloudflare-hyperdrive-aws-vpc
pnpm run deploy --profile testing --stage hyperdrive-vpc
curl "<url>"
```

Aurora incurs charges until destroyed.

## Destroy

```sh
pnpm run destroy --profile testing --stage hyperdrive-vpc
```
