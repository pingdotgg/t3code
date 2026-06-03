---
title: REST API (API Gateway v1)
description: Expose a Lambda with a regional Amazon API Gateway REST API using RestApi, Resource, Method, Deployment, and Stage primitives.
sidebar:
  order: 8
---

The [Deploy a Lambda Function](/tutorial/aws/lambda) tutorial uses a **Function URL** for HTTP. Many teams still use **Amazon API Gateway** (REST, v1) as the front door.

Alchemy models the v1 REST control plane as separate resources so you can wire integrations, stages, and custom domains explicitly.

## Try the example

The repo includes **`examples/aws-rest-api`**: a minimal **regional** REST API with `ANY` on the root and a `{proxy+}` resource, **AWS_PROXY** integration to a Lambda, then **Deployment**, **Stage** (`prod`), and **Lambda.Permission** so API Gateway can invoke the function.

```sh
cd examples/aws-rest-api
bun install
bun run deploy
```

After deploy, open the printed `invokeUrl` in a browser; you should see the Lambda’s text response.

## Shape of the stack

Typical order inside `Effect.gen`:

1. **`AWS.ApiGateway.RestApi`** — creates the API and exposes `restApiId` / `rootResourceId`.
2. **`AWS.ApiGateway.Resource`** — optional path segments (e.g. `{proxy+}`).
3. **`AWS.ApiGateway.Method`** — HTTP verb + integration (`AWS_PROXY` Lambda ARNs use `Output.interpolate` with `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`).
4. **`AWS.ApiGateway.Deployment`** — snapshots the current resource graph; change **`triggers`** (or other props) to force a new deployment when only integrations changed.
5. **`AWS.ApiGateway.Stage`** — attaches a deployment to a named stage (`prod`, `dev`, …).
6. **`AWS.Lambda.Permission`** — `principal: "apigateway.amazonaws.com"` and `sourceArn` covering `execute-api` for your API.

Use **`yield* AWS.AWSEnvironment`** for `region` and `accountId` when building ARNs (as in the example).

## Private integration (VPC link)

For **private** HTTP integrations, create a **`AWS.ApiGateway.VpcLink`** with your load balancer target ARNs, then reference `vpcLinkId` as **`integration.connectionId`** with **`connectionType: "VPC_LINK"`** on `AWS.ApiGateway.Method` (`integration.uri` points at your private backend URL).

```typescript
const link = yield* AWS.ApiGateway.VpcLink("InternalLink", {
  name: "internal-nlb",
  targetArns: [loadBalancer.loadBalancerArn],
});

yield* AWS.ApiGateway.Method("PrivateGet", {
  restApiId: api.restApiId,
  resourceId: resource.resourceId,
  httpMethod: "GET",
  integration: {
    type: "HTTP_PROXY",
    integrationHttpMethod: "GET",
    uri: "https://api.internal.example/resource",
    connectionType: "VPC_LINK",
    connectionId: link.vpcLinkId,
  },
});
```

See also [VpcLink](/providers/aws/apigateway/vpclink) in the generated API reference.

## API reference

Generated docs for each primitive live under **Providers → AWS → ApiGateway** in the sidebar (for example [RestApi](/providers/aws/apigateway/restapi)). Run `bun generate:api-reference` locally after changing JSDoc on resources.

## Next steps

- **Custom domains:** `AWS.ApiGateway.DomainName` and `AWS.ApiGateway.BasePathMapping`.
- **API keys / throttling:** `ApiKey`, `UsagePlan`, `UsagePlanKey`.
- **Authorizers:** `Authorizer` for Cognito or Lambda TOKEN / REQUEST flows.
- **Gateway responses:** `GatewayResponse` for consistent 4xx/5xx bodies.

HTTP APIs (v2) are a different product; this tutorial is **REST v1** only.
