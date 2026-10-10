# Drizzle + Aurora PostgreSQL + Lambda

[Integration guide](https://alchemy.run/aws/data/drizzle-aurora/) · [AWS setup](https://alchemy.run/aws/setup/)

## Deploy

From the repository root:

```sh
pnpm install
cd examples/aws-aurora-drizzle
pnpm deploy --profile testing --stage aurora-example
```

Use `us-west-2`; changing region also requires changing the subnet availability zones. Aurora incurs charges until destroyed.

## Query

```sh
aws lambda invoke --region us-west-2 \
  --function-name '<functionName>' \
  --cli-binary-format raw-in-base64-out \
  --payload file://health-event.json response.json
cat response.json
```

Use the printed function name and your AWS CLI credentials. The Function URL requires [SigV4-signed requests](./test/integ.test.ts).

| Method | Path | Body |
| --- | --- | --- |
| GET | `/health` | — |
| GET | `/todos` | — |
| POST | `/todos` | `{"id":"aaaaaaaa-0000-4000-8000-000000000001","title":"Ship it"}` |
| PATCH | `/todos/<uuid>` | `{"done":true}` |
| DELETE | `/todos/<uuid>` | — |

## Schema and connections

[Private network](./src/database.ts) · [Deployment-only bootstrap](./src/bootstrap.ts) · [IAM and verified TLS](./src/Api.ts)

The bootstrap creates the initial schema and restricted login. Later schema changes need versioned migrations.

## Live test

```sh
AWS_TEST_SLOW=1 ALCHEMY_PROFILE=testing bun test test/integ.test.ts
```

Creates real AWS resources and destroys them afterward. Setup and cleanup can each take several minutes.

## Destroy

```sh
pnpm destroy --profile testing --stage aurora-example
```

This deletes the database data. Wait for cleanup to finish; reuse the same profile and stage if interrupted.
