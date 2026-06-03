import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { ClusterArn } from "./Cluster.ts";

export type ServiceName = string;
export type ServiceArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:service/${string}/${ServiceName}`;

export interface ServiceProps {
  /**
   * ECS cluster that will own the service.
   */
  cluster: Input<ClusterArn> | { clusterArn: Input<ClusterArn> };

  /**
   * Bundled ECS task to run for each service replica.
   *
   * This is the runtime-facing subset of `AWS.ECS.Task` attributes that the
   * service needs in order to deploy and wire load balancer traffic.
   */
  task: {
    /**
     * Registered task definition ARN to deploy.
     */
    taskDefinitionArn: string;
    /**
     * Container name inside the task definition that should receive traffic.
     */
    containerName: string;
    /**
     * Container port that the service should expose and forward traffic to.
     */
    port: number;
  };

  /**
   * Name of the ECS service.
   * If omitted, a unique name will be generated.
   */
  serviceName?: string;

  /**
   * Desired number of running tasks.
   * @default 1
   */
  desiredCount?: number;

  /**
   * VPC that hosts the service networking and optional public ingress.
   */
  vpcId: string;

  /**
   * Subnets used by the service's awsvpc network configuration.
   */
  subnets: string[];

  /**
   * Security groups attached to the service ENIs and, when `public: true`, the
   * generated Application Load Balancer.
   */
  securityGroups?: string[];

  /**
   * Whether the service ENIs should receive public IPs.
   * @default false
   */
  assignPublicIp?: boolean;

  /**
   * Whether Alchemy should provision a public Application Load Balancer and
   * listener in front of the service.
   * @default false
   */
  public?: boolean;

  /**
   * Listener port for generated public ingress.
   * @default 80 when `certificateArn` is omitted, otherwise 443
   */
  listenerPort?: number;

  /**
   * ACM certificate ARN for HTTPS public ingress.
   * When provided, the generated listener uses HTTPS.
   */
  certificateArn?: string;

  /**
   * Target group health check path for public HTTP services.
   * @default "/"
   */
  healthCheckPath?: string;

  /**
   * Fargate platform version for the service.
   */
  platformVersion?: string;

  /**
   * Raw ECS deployment configuration overrides.
   */
  deploymentConfiguration?: ecs.DeploymentConfiguration;

  /**
   * Grace period before ECS starts evaluating target health checks.
   */
  healthCheckGracePeriodSeconds?: number;

  /**
   * User-defined tags to apply to the ECS service and generated ingress
   * resources.
   */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "AWS.ECS.Service",
  ServiceProps,
  {
    /**
     * ARN of the ECS service.
     */
    serviceArn: ServiceArn;

    /**
     * Name of the ECS service.
     */
    serviceName: ServiceName;

    /**
     * ARN of the cluster that owns the service.
     */
    clusterArn: ClusterArn;

    /**
     * Task definition revision currently deployed by the service.
     */
    taskDefinitionArn: string;

    /**
     * ECS service status such as `ACTIVE` or `DRAINING`.
     */
    status: string;

    /**
     * Public URL exposed by the generated Application Load Balancer, when
     * `public: true`.
     */
    url?: string;

    /**
     * ARN of the generated load balancer, when `public: true`.
     */
    loadBalancerArn?: string;

    /**
     * ARN of the generated target group, when `public: true`.
     */
    targetGroupArn?: string;

    /**
     * ARN of the generated listener, when `public: true`.
     */
    listenerArn?: string;
  },
  never,
  Providers
> {}

/**
 * An ECS Fargate service for running long-lived tasks.
 *
 * `Service` turns a bundled `AWS.ECS.Task` into a continuously running Fargate
 * deployment with awsvpc networking. Phase 1 focuses on the public HTTP path,
 * so the resource can optionally provision an Application Load Balancer,
 * target group, and listener when `public: true`.
 *
 * @section Creating Services
 * @example Public HTTP Service
 * ```typescript
 * const service = yield* Service("ApiService", {
 *   cluster,
 *   task: apiTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [publicSubnet1.subnetId, publicSubnet2.subnetId],
 *   securityGroups: [serviceSecurityGroup.groupId],
 *   public: true,
 * });
 * ```
 *
 * @example Internal Service
 * ```typescript
 * const service = yield* Service("WorkerService", {
 *   cluster,
 *   task: workerTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [privateSubnet1.subnetId, privateSubnet2.subnetId],
 *   securityGroups: [workerSecurityGroup.groupId],
 *   desiredCount: 2,
 * });
 * ```
 *
 * @section Public Ingress
 * @example HTTPS Service
 * ```typescript
 * const service = yield* Service("SecureApiService", {
 *   cluster,
 *   task: apiTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [publicSubnet1.subnetId, publicSubnet2.subnetId],
 *   securityGroups: [serviceSecurityGroup.groupId],
 *   public: true,
 *   certificateArn,
 *   healthCheckPath: "/health",
 * });
 * ```
 *
 * @section Deployment
 * @example Rolling Update Configuration
 * ```typescript
 * const service = yield* Service("ApiService", {
 *   cluster,
 *   task: apiTask,
 *   vpcId: vpc.vpcId,
 *   subnets: [publicSubnet1.subnetId, publicSubnet2.subnetId],
 *   securityGroups: [serviceSecurityGroup.groupId],
 *   public: true,
 *   desiredCount: 3,
 *   deploymentConfiguration: {
 *     minimumHealthyPercent: 100,
 *     maximumPercent: 200,
 *   },
 *   healthCheckGracePeriodSeconds: 30,
 * });
 * ```
 */
export const Service = Resource<Service>("AWS.ECS.Service");

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const clusterArnOf = (cluster: ServiceProps["cluster"] | ClusterArn) =>
        typeof cluster === "string"
          ? cluster
          : (((cluster as any).clusterArn ?? cluster) as string);
      const toEcsTags = (tags: Record<string, string>): ecs.Tag[] =>
        Object.entries(tags).map(([key, value]) => ({ key, value }));

      const toServiceName = (
        id: string,
        props: { serviceName?: string } = {},
      ) =>
        props.serviceName
          ? Effect.succeed(props.serviceName)
          : createPhysicalName({
              id,
              maxLength: 255,
              lowercase: true,
            });

      const ingressNames = (id: string) =>
        Effect.gen(function* () {
          const loadBalancerName = yield* createPhysicalName({
            id: `${id}-alb`,
            maxLength: 32,
            lowercase: true,
          });
          const targetGroupName = yield* createPhysicalName({
            id: `${id}-tg`,
            maxLength: 32,
            lowercase: true,
          });
          return {
            loadBalancerName,
            targetGroupName,
          };
        });

      const createIngress = Effect.fn(function* ({
        id,
        news,
      }: {
        id: string;
        news: ServiceProps;
      }) {
        const names = yield* ingressNames(id);
        const tags = {
          ...(yield* createInternalTags(id)),
          ...news.tags,
        };

        const loadBalancer = yield* elbv2.createLoadBalancer({
          Name: names.loadBalancerName,
          Type: "application",
          Scheme: "internet-facing",
          Subnets: news.subnets,
          SecurityGroups: news.securityGroups,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        });
        const lb = loadBalancer.LoadBalancers?.[0];
        if (!lb?.LoadBalancerArn || !lb.DNSName) {
          return yield* Effect.die(
            new Error("Failed to create ECS service load balancer"),
          );
        }

        const targetGroup = yield* elbv2.createTargetGroup({
          Name: names.targetGroupName,
          VpcId: news.vpcId,
          TargetType: "ip",
          Protocol: "HTTP",
          Port: news.task.port ?? 3000,
          HealthCheckPath: news.healthCheckPath ?? "/",
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        });
        const tg = targetGroup.TargetGroups?.[0];
        if (!tg?.TargetGroupArn) {
          return yield* Effect.die(
            new Error("Failed to create ECS service target group"),
          );
        }

        const listener = yield* elbv2.createListener({
          LoadBalancerArn: lb.LoadBalancerArn,
          Port: news.listenerPort ?? (news.certificateArn ? 443 : 80),
          Protocol: news.certificateArn ? "HTTPS" : "HTTP",
          Certificates: news.certificateArn
            ? [{ CertificateArn: news.certificateArn }]
            : undefined,
          DefaultActions: [
            {
              Type: "forward",
              TargetGroupArn: tg.TargetGroupArn,
            },
          ],
        });
        const ls = listener.Listeners?.[0];
        if (!ls?.ListenerArn) {
          return yield* Effect.die(
            new Error("Failed to create ECS service listener"),
          );
        }

        return {
          loadBalancerArn: lb.LoadBalancerArn,
          targetGroupArn: tg.TargetGroupArn,
          listenerArn: ls.ListenerArn,
          url: `${news.certificateArn ? "https" : "http"}://${lb.DNSName}`,
        };
      });

      const serviceInput = (
        news: ServiceProps,
        output?: Service["Attributes"],
      ) => ({
        cluster: clusterArnOf(news.cluster),
        service: output?.serviceName,
        serviceName: output?.serviceName,
        taskDefinition: news.task.taskDefinitionArn,
        desiredCount: news.desiredCount ?? 1,
        launchType: "FARGATE" as const,
        platformVersion: news.platformVersion,
        deploymentConfiguration: news.deploymentConfiguration,
        healthCheckGracePeriodSeconds: news.healthCheckGracePeriodSeconds,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: news.subnets,
            securityGroups: news.securityGroups,
            assignPublicIp: news.assignPublicIp ? "ENABLED" : "DISABLED",
          },
        },
      });

      return {
        stables: ["serviceArn", "serviceName", "clusterArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toServiceName(id, olds ?? {})) !==
            (yield* toServiceName(id, news ?? {}))
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
          if (
            !deepEqual(
              {
                cluster: olds.cluster,
                vpcId: olds.vpcId,
                subnets: olds.subnets,
                securityGroups: olds.securityGroups ?? [],
                assignPublicIp: olds.assignPublicIp ?? false,
                public: olds.public ?? false,
                listenerPort: olds.listenerPort,
                certificateArn: olds.certificateArn,
                healthCheckPath: olds.healthCheckPath,
              },
              {
                cluster: news.cluster,
                vpcId: news.vpcId,
                subnets: news.subnets,
                securityGroups: news.securityGroups ?? [],
                assignPublicIp: news.assignPublicIp ?? false,
                public: news.public ?? false,
                listenerPort: news.listenerPort,
                certificateArn: news.certificateArn,
                healthCheckPath: news.healthCheckPath,
              },
            )
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const serviceName =
            output?.serviceName ?? (yield* toServiceName(id, olds ?? {}));
          const described = yield* ecs
            .describeServices({
              cluster: output?.clusterArn ?? clusterArnOf(olds!.cluster),
              services: [serviceName],
              include: ["TAGS"],
            })
            .pipe(
              Effect.catchTag("ClusterNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const service = described?.services?.[0];
          if (!service?.serviceArn) {
            return undefined;
          }
          return {
            ...output!,
            serviceArn: service.serviceArn as ServiceArn,
            serviceName: service.serviceName!,
            clusterArn: service.clusterArn as ClusterArn,
            taskDefinitionArn: service.taskDefinition!,
            status: service.status ?? "ACTIVE",
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const serviceName = yield* toServiceName(id, news);
          const clusterArn = clusterArnOf(news.cluster) as ClusterArn;
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — describe service in target cluster. The cluster may
          // not yet exist on first reconcile, so we tolerate
          // `ClusterNotFoundException`.
          const described = yield* ecs
            .describeServices({
              cluster: clusterArn,
              services: [serviceName],
              include: ["TAGS"],
            })
            .pipe(
              Effect.catchTag("ClusterNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const observed = described?.services?.find(
            (s) =>
              s.serviceName === serviceName &&
              s.status !== "INACTIVE" &&
              s.status !== "DRAINING",
          );

          // Ensure — create if missing. Provision public ingress if
          // requested and not already in `output`. Replacement (e.g. cluster
          // change) is handled by diff returning `{ action: "replace" }`,
          // so within reconcile we trust `output` for ingress identity.
          let ingress:
            | {
                loadBalancerArn?: string;
                targetGroupArn?: string;
                listenerArn?: string;
                url?: string;
              }
            | undefined = output?.targetGroupArn
            ? {
                loadBalancerArn: output.loadBalancerArn,
                targetGroupArn: output.targetGroupArn,
                listenerArn: output.listenerArn,
                url: output.url,
              }
            : undefined;

          if (!observed?.serviceArn) {
            if (news.public && !ingress) {
              ingress = yield* createIngress({ id, news });
            }

            const created = yield* ecs.createService({
              ...serviceInput(news),
              serviceName,
              cluster: clusterArn,
              loadBalancers: ingress
                ? [
                    {
                      targetGroupArn: ingress.targetGroupArn!,
                      containerName: news.task.containerName,
                      containerPort: news.task.port ?? 3000,
                    },
                  ]
                : undefined,
              tags: toEcsTags(desiredTags),
              enableECSManagedTags: true,
            });
            const service = created.service;
            if (!service?.serviceArn) {
              return yield* Effect.die(
                new Error("createService returned no service"),
              );
            }
            yield* session.note(service.serviceArn);
            return {
              serviceArn: service.serviceArn as ServiceArn,
              serviceName: service.serviceName!,
              clusterArn: service.clusterArn as ClusterArn,
              taskDefinitionArn: service.taskDefinition!,
              status: service.status ?? "ACTIVE",
              url: ingress?.url,
              loadBalancerArn: ingress?.loadBalancerArn,
              targetGroupArn: ingress?.targetGroupArn,
              listenerArn: ingress?.listenerArn,
            };
          }

          // Sync — apply mutable fields (taskDefinition, desiredCount,
          // network, deployment) via updateService with a forced new
          // deployment.
          const updated = yield* ecs.updateService({
            ...serviceInput(news, output),
            service: serviceName,
            cluster: clusterArn,
            loadBalancers: ingress?.targetGroupArn
              ? [
                  {
                    targetGroupArn: ingress.targetGroupArn,
                    containerName: news.task.containerName,
                    containerPort: news.task.port ?? 3000,
                  },
                ]
              : undefined,
            forceNewDeployment: true,
          });
          const service = updated.service;
          yield* session.note(observed.serviceArn);
          return {
            serviceArn: observed.serviceArn as ServiceArn,
            serviceName: observed.serviceName!,
            clusterArn: observed.clusterArn as ClusterArn,
            taskDefinitionArn:
              service?.taskDefinition ??
              observed.taskDefinition ??
              output?.taskDefinitionArn ??
              "",
            status: service?.status ?? observed.status ?? "ACTIVE",
            url: ingress?.url,
            loadBalancerArn: ingress?.loadBalancerArn,
            targetGroupArn: ingress?.targetGroupArn,
            listenerArn: ingress?.listenerArn,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* ecs
            .updateService({
              cluster: output.clusterArn,
              service: output.serviceName,
              desiredCount: 0,
            })
            .pipe(
              Effect.catchTag("ServiceNotFoundException", () => Effect.void),
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
            );

          yield* ecs
            .deleteService({
              cluster: output.clusterArn,
              service: output.serviceName,
              force: true,
            })
            .pipe(
              Effect.catchTag("ServiceNotFoundException", () => Effect.void),
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
            );

          if (output.listenerArn) {
            yield* elbv2
              .deleteListener({
                ListenerArn: output.listenerArn,
              })
              .pipe(
                Effect.catchTag("ListenerNotFoundException", () => Effect.void),
              );
          }
          if (output.targetGroupArn) {
            yield* elbv2
              .deleteTargetGroup({
                TargetGroupArn: output.targetGroupArn,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          if (output.loadBalancerArn) {
            yield* elbv2
              .deleteLoadBalancer({
                LoadBalancerArn: output.loadBalancerArn,
              })
              .pipe(
                Effect.catchTag(
                  "LoadBalancerNotFoundException",
                  () => Effect.void,
                ),
              );
          }
        }),
      };
    }),
  );
