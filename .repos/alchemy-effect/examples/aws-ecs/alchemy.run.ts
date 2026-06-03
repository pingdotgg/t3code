import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import QueueConsumerTask from "./src/QueueConsumerTask.ts";
import ApiTask from "./src/Task.ts";

const aws = AWS.providers();

export default Alchemy.Stack(
  "AwsEcsExample",
  {
    providers: aws,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("ExampleNetwork", {
      cidrBlock: "10.42.0.0/16",
      availabilityZones: 2,
    });

    const serviceSecurityGroup = yield* AWS.EC2.SecurityGroup(
      "ExampleServiceSecurityGroup",
      {
        vpcId: network.vpcId,
        description: "Security group for the ECS example services",
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrIpv4: "0.0.0.0/0",
          },
          {
            ipProtocol: "tcp",
            fromPort: 3000,
            toPort: 3000,
            cidrIpv4: "0.0.0.0/0",
          },
        ],
      },
    );

    const queue = yield* AWS.SQS.Queue("ExampleJobsQueue", {
      receiveMessageWaitTimeSeconds: 20,
      visibilityTimeout: 60,
    });

    const cluster = yield* AWS.ECS.Cluster("ExampleCluster", {});
    const apiTask = yield* ApiTask;
    const queuePollerTask = yield* QueueConsumerTask;

    const apiService = yield* AWS.ECS.Service("ExampleApiService", {
      cluster,
      task: apiTask,
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      securityGroups: [serviceSecurityGroup.groupId],
      assignPublicIp: true,
      public: true,
      healthCheckPath: "/",
    });

    yield* AWS.ECS.Service("ExampleQueuePollerService", {
      cluster,
      task: queuePollerTask,
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      securityGroups: [serviceSecurityGroup.groupId],
      assignPublicIp: true,
      desiredCount: 1,
    });

    return {
      url: apiService.url,
      queueUrl: queue.queueUrl,
      enqueueExample: Output.interpolate`${apiService.url}/enqueue?message=hello`,
    };
  }),
);
