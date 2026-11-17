# @alchemy.run/aws

AWS for [Alchemy](https://alchemy.run). Declare Lambda functions, S3, SQS, DynamoDB, ECS, EKS and 200 more services in the same TypeScript program as the code that uses them. Bindings write the least-privilege IAM policy for you.

```sh
npm install alchemy @alchemy.run/aws effect
```

A Lambda function binds two S3 operations on a bucket:

```typescript
// src/api.ts
import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export default class Api extends AWS.Lambda.Function<Api>()(
  "Api",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("Bucket");
    // Each binding adds exactly one IAM permission to the function's role.
    const putObject = yield* AWS.S3.PutObject(bucket);
    const getObject = yield* AWS.S3.GetObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = request.url.split("/").pop()!;
        if (request.method === "PUT") {
          yield* putObject({ Key: key, Body: yield* request.text });
          return HttpServerResponse.empty({ status: 201 });
        }
        const object = yield* getObject({ Key: key }).pipe(
          Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
        );
        if (!object?.Body) {
          return HttpServerResponse.text("Not found", { status: 404 });
        }
        return HttpServerResponse.stream(object.Body);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(AWS.S3.PutObjectHttp, AWS.S3.GetObjectHttp))),
) {}
```

The Stack deploys it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.functionUrl };
  }),
);
```

`alchemy deploy` creates the bucket, the function, its role, and a policy that allows `s3:PutObject` and `s3:GetObject` on that bucket only.

## Learn more

- [AWS on alchemy.run](https://alchemy.run/aws)
- [Setup](https://alchemy.run/aws/setup)
- [Tutorial](https://alchemy.run/aws/tutorial/part-1)
- [API reference](https://alchemy.run/providers)
