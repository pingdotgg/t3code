import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import JobFunction from "./src/JobFunction.ts";

const aws = AWS.providers();

export default Alchemy.Stack(
  "AwsRestApiProxy",
  {
    providers: aws,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { region, accountId } = yield* AWS.AWSEnvironment;

    const fn = yield* JobFunction;

    const api = yield* AWS.ApiGateway.RestApi("PublicApi", {
      name: "alchemy-example-rest-api",
      endpointConfiguration: { types: ["REGIONAL"] },
    });

    const proxyResource = yield* AWS.ApiGateway.Resource("Proxy", {
      restApiId: api.restApiId,
      parentId: api.rootResourceId,
      pathPart: "{proxy+}",
    });

    const invokeUri = Output.interpolate`arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fn.functionArn}/invocations`;

    yield* AWS.ApiGateway.Method("RootAny", {
      restApiId: api.restApiId,
      resourceId: api.rootResourceId,
      httpMethod: "ANY",
      authorizationType: "NONE",
      integration: {
        type: "AWS_PROXY",
        integrationHttpMethod: "POST",
        uri: invokeUri,
      },
    });

    yield* AWS.ApiGateway.Method("ProxyAny", {
      restApiId: api.restApiId,
      resourceId: proxyResource.resourceId,
      httpMethod: "ANY",
      authorizationType: "NONE",
      integration: {
        type: "AWS_PROXY",
        integrationHttpMethod: "POST",
        uri: invokeUri,
      },
    });

    const deployment = yield* AWS.ApiGateway.Deployment("Release", {
      restApiId: api.restApiId,
      description: "initial",
      triggers: {
        rootMethod: "ANY",
        proxyMethod: "ANY",
      },
    });

    const stage = yield* AWS.ApiGateway.Stage("ProdStage", {
      restApiId: api.restApiId,
      stageName: "prod",
      deploymentId: deployment.deploymentId,
    });

    yield* AWS.Lambda.Permission("ApiGatewayInvoke", {
      action: "lambda:InvokeFunction",
      functionName: fn.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: Output.interpolate`arn:aws:execute-api:${region}:${accountId}:${api.restApiId}/*/*/*`,
    });

    return {
      invokeUrl: Output.interpolate`https://${api.restApiId}.execute-api.${region}.amazonaws.com/${stage.stageName}/`,
      restApiId: api.restApiId,
    };
  }),
);
