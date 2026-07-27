import * as EC2 from "@/AWS/EC2";
import * as ECS from "@/AWS/ECS";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class EcsBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "EcsBindingsTestFunction",
) {}

// `ECS.Task` is a Platform; its static type doesn't surface the
// `ResourceClass.ref` that the runtime object carries (plain `Resource`
// classes like `ECS.Cluster` type it). Narrow it here.
const TaskRef = ECS.Task as unknown as {
  ref: (id: string) => Effect.Effect<ECS.Task>;
};

/**
 * Lambda fixture hosting the ECS task-control bindings:
 * `RunTask`, `StopTask`, `DescribeTasks`, `ListTasks` — one HTTP route per
 * operation.
 *
 * The cluster, one-shot task definition, and public subnet are deployed by
 * the test's stack program (phase 1) and referenced here via
 * `Resource.ref(...)`. Yielding them inline would re-execute their layers
 * inside the Lambda runtime — and nesting a Platform resource (the ECS
 * `Task`) under the Lambda bridge's intercepting ConfigProvider recurses
 * config lookups until the sandbox OOMs. Refs resolve from stack state at
 * deploy and from the injected environment at runtime.
 */
export default EcsBindingsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
    memorySize: 512,
  },
  Effect.gen(function* () {
    const cluster = yield* ECS.Cluster.ref("EcsBindingsCluster");
    const task = yield* TaskRef.ref("EcsBindingsOneShotTask");
    const subnet = yield* EC2.Subnet.ref("EcsBindingsSubnet");

    const runTask = yield* ECS.RunTask(cluster, task);
    const stopTask = yield* ECS.StopTask(cluster);
    const describeTasks = yield* ECS.DescribeTasks(cluster);
    const listTasks = yield* ECS.ListTasks(cluster);
    const describeServices = yield* ECS.DescribeServices(cluster);
    const listServices = yield* ECS.ListServices(cluster);
    const listContainerInstances = yield* ECS.ListContainerInstances(cluster);
    const getTaskProtection = yield* ECS.GetTaskProtection(cluster);
    const updateTaskProtection = yield* ECS.UpdateTaskProtection(cluster);

    const SubnetId = yield* subnet.subnetId;
    const ContainerName = yield* task.containerName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/run") {
          const body = (yield* request.json) as unknown as {
            command?: string[];
            startedBy?: string;
          };
          const subnetId = yield* SubnetId;
          const containerName = yield* ContainerName;
          const response = yield* runTask({
            launchType: "FARGATE",
            count: 1,
            startedBy: body.startedBy ?? "alchemy-ecs-bindings-test",
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: [subnetId],
                // No securityGroups: the VPC default security group applies
                // (all egress allowed — enough to pull the image from ECR).
                assignPublicIp: "ENABLED",
              },
            },
            ...(body.command
              ? {
                  overrides: {
                    containerOverrides: [
                      { name: containerName, command: body.command },
                    ],
                  },
                }
              : {}),
          });
          return yield* HttpServerResponse.json({
            taskArn: response.tasks?.[0]?.taskArn,
            lastStatus: response.tasks?.[0]?.lastStatus,
            failures: response.failures,
          });
        }

        if (request.method === "POST" && pathname === "/stop") {
          const body = (yield* request.json) as unknown as {
            taskArn: string;
            reason?: string;
          };
          const response = yield* stopTask({
            task: body.taskArn,
            reason: body.reason,
          });
          return yield* HttpServerResponse.json({
            taskArn: response.task?.taskArn,
            lastStatus: response.task?.lastStatus,
            desiredStatus: response.task?.desiredStatus,
          });
        }

        if (request.method === "GET" && pathname === "/describe") {
          const taskArn = url.searchParams.get("task");
          if (!taskArn) {
            return HttpServerResponse.text("Missing task", { status: 400 });
          }
          const response = yield* describeTasks({ tasks: [taskArn] });
          return yield* HttpServerResponse.json({
            tasks: response.tasks?.map((t) => ({
              taskArn: t.taskArn,
              lastStatus: t.lastStatus,
              stoppedReason: t.stoppedReason,
              startedBy: t.startedBy,
              containers: t.containers?.map((c) => ({
                name: c.name,
                exitCode: c.exitCode,
                lastStatus: c.lastStatus,
              })),
            })),
            failures: response.failures,
          });
        }

        if (request.method === "GET" && pathname === "/list") {
          const desiredStatus = url.searchParams.get("status");
          const startedBy = url.searchParams.get("startedBy");
          const response = yield* listTasks({
            ...(desiredStatus
              ? { desiredStatus: desiredStatus as "RUNNING" | "STOPPED" }
              : {}),
            ...(startedBy ? { startedBy } : {}),
          });
          return yield* HttpServerResponse.json({
            taskArns: response.taskArns ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/services") {
          const response = yield* listServices({});
          return yield* HttpServerResponse.json({
            serviceArns: response.serviceArns ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/describe-services") {
          const service = url.searchParams.get("service");
          if (!service) {
            return HttpServerResponse.text("Missing service", { status: 400 });
          }
          const response = yield* describeServices({ services: [service] });
          return yield* HttpServerResponse.json({
            services: response.services?.map((s) => ({
              serviceName: s.serviceName,
              status: s.status,
            })),
            failures: response.failures,
          });
        }

        if (request.method === "GET" && pathname === "/container-instances") {
          const response = yield* listContainerInstances({});
          return yield* HttpServerResponse.json({
            containerInstanceArns: response.containerInstanceArns ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/protection") {
          const taskArn = url.searchParams.get("task");
          if (!taskArn) {
            return HttpServerResponse.text("Missing task", { status: 400 });
          }
          const response = yield* getTaskProtection({ tasks: [taskArn] }).pipe(
            Effect.map((r) => ({
              protectedTasks: r.protectedTasks,
              failures: r.failures,
            })),
            Effect.catchTag(
              ["InvalidParameterException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ error: e._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "POST" && pathname === "/protect") {
          const body = (yield* request.json) as unknown as {
            taskArn: string;
          };
          const response = yield* updateTaskProtection({
            tasks: [body.taskArn],
            protectionEnabled: true,
            // Duration.Input → whole wire minutes via the central util.
            expiresIn: "10 minutes",
          }).pipe(
            Effect.map((r) => ({
              protectedTasks: r.protectedTasks,
              failures: r.failures,
            })),
            Effect.catchTag(
              ["InvalidParameterException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ error: e._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(response);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ECS.RunTaskHttp,
        ECS.StopTaskHttp,
        ECS.DescribeTasksHttp,
        ECS.ListTasksHttp,
        ECS.DescribeServicesHttp,
        ECS.ListServicesHttp,
        ECS.ListContainerInstancesHttp,
        ECS.GetTaskProtectionHttp,
        ECS.UpdateTaskProtectionHttp,
      ),
    ),
  ),
);
