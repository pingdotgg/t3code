import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "aws",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AwsAuth,
  ),
  stateStores: {
    aws: {
      description: "DynamoDB state store in the profile's AWS account",
      load: Contributions.lazy(
        () => import("./Alchemist/DynamoDBStateStore.ts"),
        (module) => module.stateStore,
      ),
    },
    "aws-s3": {
      description: "S3 state store in the profile's AWS account",
      load: Contributions.lazy(
        () => import("./Alchemist/StateStore.ts"),
        (module) => module.s3StateStore,
      ),
    },
  },
  cli: {
    provider: {
      description: "Manage AWS provider prerequisites",
      load: Contributions.lazy(
        () => import("./Cli.ts"),
        (module) => module.awsCommand,
      ),
    },
  },
  testServices: Contributions.lazy(
    () => import("./Local/TestServices.ts"),
    (module) => module.testServices(),
  ),
  devEnv: Contributions.lazy(
    () => import("./Local/DevEnv.ts"),
    (module) => module.devEnv,
  ),
});
