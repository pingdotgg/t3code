# Drizzle + Aurora DSQL + Lambda

[Integration guide](https://alchemy.run/aws/data/drizzle-dsql/) · [AWS setup](https://alchemy.run/aws/setup/)

## Deploy

From the repository root:

```sh
pnpm install
cd examples/aws-dsql-drizzle
pnpm deploy --profile testing
```

Use a DSQL region such as `us-west-2`. Deployment needs `dsql:DbConnectAdmin` and network access to port 5432; these resources incur AWS charges.

## Query

```sh
aws lambda invoke --region us-west-2 \
  --function-name '<functionName>' \
  --cli-binary-format raw-in-base64-out \
  --payload file://health-event.json response.json
cat response.json
```

Use the printed function name. [Signed HTTP CRUD examples](./test/integ.test.ts).

## Schema and connections

[Cluster](./src/database.ts) · [Deployment-only bootstrap](./src/bootstrap.ts) · [Non-admin connection and verified TLS](./src/client.ts)

Initial setup creates `app.todos` and `app_user`. Later schema changes need versioned, [DSQL-compatible migrations](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html).

## Live test

```sh
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
```

## Destroy

```sh
pnpm destroy --profile testing
aws dsql get-cluster --region us-west-2 --identifier '<clusterId>'
```

Destroy deletes the database data. Deletion is asynchronous; wait for `DELETED` or `ResourceNotFoundException`.
