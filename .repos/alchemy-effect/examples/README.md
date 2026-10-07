# Alchemy examples

[SQL clients](https://alchemy.run/sql) · [Providers](https://alchemy.run/sql#find-your-provider)

Examples create billable infrastructure. Follow each README's cleanup commands.

## SQL integrations

| Runtime | Database | Client | Runnable project |
| --- | --- | --- | --- |
| AWS Lambda | Aurora PostgreSQL | Drizzle | [aws-aurora-drizzle](./aws-aurora-drizzle) |
| AWS Lambda | Aurora DSQL | Drizzle | [aws-dsql-drizzle](./aws-dsql-drizzle) |
| AWS Lambda | Aurora PostgreSQL | `pg` | [aws-rds](./aws-rds) |
| Cloudflare Workers | Neon Postgres through Hyperdrive | Drizzle | [cloudflare-neon-drizzle](./cloudflare-neon-drizzle) |
| Cloudflare Durable Objects | SQLite per object | Drizzle | [cloudflare-durable-object-sql](./cloudflare-durable-object-sql) |
| Cloudflare Workers | PlanetScale Postgres through Hyperdrive | Drizzle | [cloudflare-planetscale-postgres-drizzle](./cloudflare-planetscale-postgres-drizzle) |
| Cloudflare Workers | Neon Postgres through Hyperdrive | Prisma ORM, TypeScript-first | [cloudflare-neon-prisma](./cloudflare-neon-prisma) |
| Cloudflare Workers | Neon Postgres through Hyperdrive | Prisma ORM, PSL-first | [cloudflare-neon-prisma-psl](./cloudflare-neon-prisma-psl) |
| Fly Service | Fly Managed Postgres | Drizzle | [fly-postgres](./fly-postgres) |
| Hetzner Service | Neon Postgres | Drizzle | [hetzner-website-vite](./hetzner-website-vite) |
| Railway Service | Railway Postgres | Drizzle | [railway-service](./railway-service) |

### Looking for Drizzle + Aurora?

[Aurora PostgreSQL guide](https://alchemy.run/aws/data/drizzle-aurora) · [Aurora DSQL guide](https://alchemy.run/aws/data/drizzle-dsql)

These are separate database integrations. `aws-rds` uses plain `pg`, not Drizzle.

## Guides and lifecycle

- [Choose a database](https://alchemy.run/sql/databases).
- [Drizzle](https://alchemy.run/sql/drizzle/postgres) and [Prisma contracts](https://alchemy.run/sql/prisma/contracts).
- [Connection lifecycle](https://alchemy.run/sql/effect-sql/lifecycle).
- [AWS](https://alchemy.run/aws/setup), [Cloudflare](https://alchemy.run/cloudflare/setup), [Fly](https://alchemy.run/fly/setup), [Hetzner](https://alchemy.run/hetzner/setup), and [Railway](https://alchemy.run/railway/setup) credentials.
