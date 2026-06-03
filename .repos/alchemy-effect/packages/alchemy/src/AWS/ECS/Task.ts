import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import { Region } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  dockerBuild,
  materializeDockerfile,
  pushImage,
  writeContextFiles,
} from "../../Bundle/Docker.ts";
import {
  findCwdForBundle,
  getStableContextDir,
} from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import type { ProcessContext, ServerHost } from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags, createTagsList, hasTags } from "../../Tags.ts";
import type { Credentials } from "../Credentials.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export const isTask = (value: any): value is Task => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.ECS.Task"
  );
};

export class TaskEnvironment extends Context.Service<
  TaskEnvironment,
  Record<string, any>
>()("AWS.ECS.TaskEnvironment") {}

export interface TaskProps extends PlatformProps {
  /**
   * Module entrypoint for the bundled task program. This should typically be
   * `import.meta.filename` from an inline Effect program.
   */
  main: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * ECS task family. If omitted, a unique family is generated.
   */
  taskName?: string;
  /**
   * Task-level cpu configuration for Fargate.
   * @default 256
   */
  cpu?: number;
  /**
   * Task-level memory configuration for Fargate.
   * @default 512
   */
  memory?: number;
  /**
   * HTTP port exposed by the container.
   * @default 3000
   */
  port?: number;
  /**
   * Additional environment variables for the container.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for the task entrypoint.
   */
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
  /**
   * Docker image build: optional full {@link docker.dockerfile}. When omitted,
   * Alchemy generates a Dockerfile for the bundled `index.mjs`.
   */
  docker?: {
    /**
     * Base image when Alchemy generates the Dockerfile.
     * @default public.ecr.aws/docker/library/bun:1
     */
    base?: string;
    /** Full Dockerfile content (replaces generated Dockerfile). */
    dockerfile?: string;
  };
  /**
   * Container definition overrides applied after Alchemy's defaults.
   */
  container?: Partial<ecs.ContainerDefinition>;
  /**
   * Additional task definition overrides.
   */
  taskDefinition?: Partial<
    Omit<
      ecs.RegisterTaskDefinitionRequest,
      | "family"
      | "containerDefinitions"
      | "executionRoleArn"
      | "taskRoleArn"
      | "cpu"
      | "memory"
      | "networkMode"
      | "requiresCompatibilities"
    >
  >;
  /**
   * Additional managed policy ARNs for the task role.
   */
  taskRoleManagedPolicyArns?: string[];
  /**
   * Additional managed policy ARNs for the execution role.
   */
  executionRoleManagedPolicyArns?: string[];
  /**
   * User-defined tags to apply to task-owned resources.
   */
  tags?: Record<string, string>;
}

export interface Task extends Resource<
  "AWS.ECS.Task",
  TaskProps,
  {
    taskDefinitionArn: string;
    taskFamily: string;
    containerName: string;
    port: number;
    imageUri: string;
    repositoryName: string;
    repositoryUri: string;
    taskRoleArn: string;
    taskRoleName: string;
    executionRoleArn: string;
    executionRoleName: string;
    logGroupName: string;
    logGroupArn: string;
    code: {
      hash: string;
    };
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type TaskServices = Credentials | Region | ServerHost;

export type TaskShape = Main<TaskServices>;

export interface TaskRuntimeContext extends ProcessContext {
  readonly Type: "AWS.ECS.Task";
}

export const Task: Platform<Task, TaskServices, TaskShape, TaskRuntimeContext> =
  Platform("AWS.ECS.Task", {
    createRuntimeContext: (id): TaskRuntimeContext => {
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};

      return {
        Type: "AWS.ECS.Task",
        id,
        env,
        set: (bindingId: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
            env[key] = output.pipe(
              Output.map((value) => JSON.stringify(value)),
            );
            return key;
          }),
        get: <T>(key: string) =>
          Config.string(key).pipe(
            Effect.flatMap((value) =>
              Effect.try({
                try: () => JSON.parse(value) as T,
                catch: (error) => error as Error,
              }),
            ),
            Effect.catch((cause) =>
              Effect.die(
                new Error(`Failed to get environment variable: ${key}`, {
                  cause,
                }),
              ),
            ),
          ),
        run: (effect: Effect.Effect<void, never, any>) =>
          Effect.sync(() => {
            runners.push(effect);
          }),
      };
    },
  });

export const TaskProvider = () =>
  Provider.effect(
    Task,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const { accountId } = yield* AWSEnvironment;
      const region = yield* Region;
      const { dotAlchemy } = yield* AlchemyContext;
      const fs = yield* FileSystem.FileSystem;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const toTaskFamily = (id: string, props: { taskName?: string } = {}) =>
        props.taskName
          ? Effect.succeed(props.taskName)
          : createPhysicalName({
              id,
              maxLength: 255,
              lowercase: true,
            });

      const createRoleName = (id: string, suffix: string) =>
        createPhysicalName({
          id: `${id}-${suffix}`,
          maxLength: 64,
        });

      const createPolicyName = (id: string, suffix: string) =>
        createPhysicalName({
          id: `${id}-${suffix}`,
          maxLength: 128,
        });

      const createRepositoryName = (id: string) =>
        createPhysicalName({
          id: `${id}-repo`,
          maxLength: 256,
          lowercase: true,
        });

      const createLogGroupName = (id: string) =>
        createPhysicalName({
          id: `${id}-logs`,
          maxLength: 512,
          lowercase: true,
        });

      const createTaskRoleIfNotExists = Effect.fn(function* ({
        id,
        roleName,
      }: {
        id: string;
        roleName: string;
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "ecs-tasks.amazonaws.com",
                  },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }).pipe(
                Effect.filterOrFail(
                  (existing) => hasTags(tags, existing.Role?.Tags),
                  () =>
                    new Error(
                      `Role '${roleName}' already exists and is not managed by alchemy`,
                    ),
                ),
              ),
            ),
          );
        return role.Role!.Arn!;
      });

      const ensureExecutionRole = Effect.fn(function* ({
        id,
        roleName,
        managedPolicyArns,
      }: {
        id: string;
        roleName: string;
        managedPolicyArns?: string[];
      }) {
        const roleArn = yield* createTaskRoleIfNotExists({ id, roleName });
        const policies = [
          "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
          ...(managedPolicyArns ?? []),
        ];
        for (const policyArn of policies) {
          yield* iam
            .attachRolePolicy({
              RoleName: roleName,
              PolicyArn: policyArn,
            })
            .pipe(Effect.catchTag("LimitExceededException", () => Effect.void));
        }
        return roleArn;
      });

      const ensureRepository = Effect.fn(function* ({
        repositoryName,
        tags,
      }: {
        id: string;
        repositoryName: string;
        tags: Record<string, string>;
      }) {
        const created = yield* ecr
          .createRepository({
            repositoryName,
            imageTagMutability: "MUTABLE",
            imageScanningConfiguration: {
              scanOnPush: true,
            },
            tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("RepositoryAlreadyExistsException", () =>
              Effect.gen(function* () {
                const existing = yield* ecr.describeRepositories({
                  repositoryNames: [repositoryName],
                });
                return {
                  repository: existing.repositories?.[0],
                };
              }),
            ),
          );
        const repository = created.repository;
        if (!repository?.repositoryUri || !repository.repositoryArn) {
          return yield* Effect.die(
            new Error(`Failed to resolve ECR repository '${repositoryName}'`),
          );
        }
        return {
          repositoryUri: repository.repositoryUri,
          repositoryArn: repository.repositoryArn,
        };
      });

      const ensureLogGroup = Effect.fn(function* ({
        id,
        logGroupName,
      }: {
        id: string;
        logGroupName: string;
      }) {
        const tags = yield* createInternalTags(id);
        yield* logs
          .createLogGroup({
            logGroupName,
            tags,
          })
          .pipe(
            Effect.catchTag(
              "ResourceAlreadyExistsException",
              () => Effect.void,
            ),
          );
        return `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`;
      });

      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        bindings: ResourceBinding<Task["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (binding: ResourceBinding<Task["Binding"]> & { action?: string }) =>
            binding.action !== "delete",
        );

        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, value) => ({ ...acc, ...value }), {});

        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map((statement) => ({
              ...statement,
              Sid: statement.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
        );

        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            }),
          });
        } else {
          yield* iam
            .deleteRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return env;
      });

      const decodeAuthorizationToken = (token: string) => {
        const decoded = Buffer.from(token, "base64").toString("utf8");
        const [, password] = decoded.split(":", 2);
        return password;
      };

      const bundleProgram = Effect.fn(function* (id: string, props: TaskProps) {
        const handler = props.handler ?? "default";
        const realMain = yield* fs.realPath(props.main);
        const cwd = yield* findCwdForBundle(realMain);

        const buildBundle = Effect.fnUntraced(function* (
          entry: string,
          plugins?: rolldown.RolldownPluginOption,
        ) {
          return yield* Bundle.build(
            {
              ...props.build?.input,
              input: entry,
              cwd,
              platform: "node",
              plugins: [props.build?.input?.plugins, plugins],
            },
            {
              ...props.build?.output,
              format: "esm",
              sourcemap: props.build?.output?.sourcemap ?? false,
              minify: props.build?.output?.minify ?? true,
              entryFileNames: "index.js",
            },
          );
        });

        const bundleOutput = props.isExternal
          ? yield* buildBundle(realMain)
          : yield* buildBundle(
              realMain,
              virtualEntryPlugin(
                (importPath) => `
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as handler } from ${JSON.stringify(importPath)};

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const program = handler.pipe(
  Effect.flatMap((task) => task.RuntimeContext.exports.program),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    ).pipe(
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
    )
  ),
  Effect.scoped
);

await Effect.runPromise(program);
`,
              ),
            );

        const mainFile = bundleOutput.files[0];
        const code =
          typeof mainFile.content === "string"
            ? new TextEncoder().encode(mainFile.content)
            : mainFile.content;

        return { code, hash: bundleOutput.hash };
      });

      const buildAndPushImage = Effect.fn(function* ({
        id,
        repositoryUri,
        hash,
        code,
        props,
      }: {
        id: string;
        repositoryUri: string;
        hash: string;
        code: Uint8Array<ArrayBufferLike>;
        props: TaskProps;
      }) {
        const realMain = yield* fs.realPath(props.main);
        const contextDir = yield* getStableContextDir(
          realMain,
          dotAlchemy,
          `${id}-image`,
        );
        const imageUri = `${repositoryUri}:${hash}`;

        const generatedDockerfile = (() => {
          const base =
            props.docker?.base ?? "public.ecr.aws/docker/library/bun:1";
          const lines = [
            `FROM ${base}`,
            `WORKDIR /app`,
            `COPY index.mjs /app/index.mjs`,
          ];
          if (props.port !== undefined) {
            lines.push(
              `ENV PORT=${String(props.port)}`,
              `EXPOSE ${String(props.port)}`,
            );
          }
          lines.push(`ENTRYPOINT ["bun", "/app/index.mjs"]`);
          return `${lines.join("\n")}\n`;
        })();

        const dockerfile = props.docker?.dockerfile ?? generatedDockerfile;

        const auth = yield* ecr.getAuthorizationToken({});
        const credentials = auth.authorizationData?.[0];
        if (!credentials?.authorizationToken || !credentials.proxyEndpoint) {
          return yield* Effect.die(
            new Error("Failed to get ECR authorization token"),
          );
        }
        const password = decodeAuthorizationToken(
          credentials.authorizationToken,
        );
        const registry = credentials.proxyEndpoint.replace(/^https?:\/\//, "");

        yield* materializeDockerfile(dockerfile, contextDir);
        yield* writeContextFiles(contextDir, [
          { path: "index.mjs", content: code },
        ]);
        yield* dockerBuild({
          tag: imageUri,
          context: contextDir,
        });
        yield* pushImage(imageUri, {
          username: "AWS",
          password,
          server: registry,
        });

        return imageUri;
      });

      const registerTaskDefinition = Effect.fn(function* ({
        props,
        family,
        imageUri,
        taskRoleArn,
        executionRoleArn,
        logGroupName,
      }: {
        props: TaskProps;
        family: string;
        imageUri: string;
        taskRoleArn: string;
        executionRoleArn: string;
        logGroupName: string;
      }) {
        const containerName = props.container?.name ?? family;
        const response = yield* ecs.registerTaskDefinition({
          family,
          taskRoleArn,
          executionRoleArn,
          networkMode: "awsvpc",
          requiresCompatibilities: ["FARGATE"],
          cpu: String(props.cpu ?? 256),
          memory: String(props.memory ?? 512),
          ...props.taskDefinition,
          containerDefinitions: [
            {
              essential: true,
              name: containerName,
              image: imageUri,
              portMappings:
                props.port !== undefined
                  ? [
                      {
                        containerPort: props.port,
                        hostPort: props.port,
                        protocol: "tcp",
                      },
                    ]
                  : undefined,
              environment: Object.entries(props.env ?? {}).map(
                ([name, value]) => ({
                  name,
                  value:
                    typeof value === "string" ? value : JSON.stringify(value),
                }),
              ),
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": logGroupName,
                  "awslogs-region": region,
                  "awslogs-stream-prefix": family,
                },
              },
              ...props.container,
            },
          ],
        });
        const taskDefinition = response.taskDefinition;
        if (!taskDefinition?.taskDefinitionArn) {
          return yield* Effect.die(
            new Error("registerTaskDefinition returned no task definition"),
          );
        }
        return taskDefinition;
      });

      return {
        stables: [
          "repositoryName",
          "repositoryUri",
          "taskRoleArn",
          "taskRoleName",
          "executionRoleArn",
          "executionRoleName",
          "logGroupName",
          "logGroupArn",
          "taskFamily",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toTaskFamily(id, olds ?? {})) !==
            (yield* toTaskFamily(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const family =
            output?.taskFamily ?? (yield* toTaskFamily(id, olds ?? {}));
          const described = yield* ecs
            .describeTaskDefinition({
              taskDefinition: output?.taskDefinitionArn ?? family,
            })
            .pipe(
              Effect.catchTag("ClientException", () =>
                Effect.succeed(undefined),
              ),
            );
          const taskDefinition = described?.taskDefinition;
          if (!taskDefinition?.taskDefinitionArn) {
            return undefined;
          }
          if (!output) {
            return undefined;
          }
          return {
            ...output,
            taskDefinitionArn: taskDefinition.taskDefinitionArn,
            taskFamily: taskDefinition.family ?? family,
            containerName:
              taskDefinition.containerDefinitions?.[0]?.name ??
              output.containerName,
            port:
              taskDefinition.containerDefinitions?.[0]?.portMappings?.[0]
                ?.containerPort ?? output.port,
          };
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const family = yield* toTaskFamily(id, news);
          const taskRoleName =
            output?.taskRoleName ?? (yield* createRoleName(id, "task-role"));
          const executionRoleName =
            output?.executionRoleName ??
            (yield* createRoleName(id, "execution-role"));
          const taskPolicyName = yield* createPolicyName(id, "task-policy");
          const repositoryName =
            output?.repositoryName ?? (yield* createRepositoryName(id));
          const logGroupName =
            output?.logGroupName ?? (yield* createLogGroupName(id));
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Ensure roles, repository, and log group. Each helper is
          // idempotent (creates on miss, adopts on race) so the same
          // sequence runs on initial create, adoption, or update.
          const taskRoleArn =
            output?.taskRoleArn ??
            (yield* createTaskRoleIfNotExists({ id, roleName: taskRoleName }));
          const executionRoleArn =
            output?.executionRoleArn ??
            (yield* ensureExecutionRole({
              id,
              roleName: executionRoleName,
              managedPolicyArns: news.executionRoleManagedPolicyArns,
            }));

          for (const policyArn of news.taskRoleManagedPolicyArns ?? []) {
            yield* iam
              .attachRolePolicy({
                RoleName: taskRoleName,
                PolicyArn: policyArn,
              })
              .pipe(
                Effect.catchTag("LimitExceededException", () => Effect.void),
              );
          }

          const bindingEnv = yield* attachBindings({
            roleName: taskRoleName,
            policyName: taskPolicyName,
            bindings,
          });

          const { repositoryUri } =
            output?.repositoryUri && output?.repositoryName === repositoryName
              ? {
                  repositoryUri: output.repositoryUri,
                }
              : yield* ensureRepository({
                  id,
                  repositoryName,
                  tags,
                });
          const logGroupArn =
            output?.logGroupArn ??
            (yield* ensureLogGroup({
              id,
              logGroupName,
            }));

          // Build, push, and register a new task definition revision. Task
          // definitions are versioned in AWS, so registering a new revision
          // is the unit of "update" — the prior revision is deregistered
          // only on `delete` of the resource.
          const { code, hash } = yield* bundleProgram(id, news);
          const imageUri = yield* buildAndPushImage({
            id,
            repositoryUri,
            hash,
            code,
            props: {
              ...news,
              env: {
                ...bindingEnv,
                ...alchemyEnv,
                ...news.env,
              },
            },
          });
          const taskDefinition = yield* registerTaskDefinition({
            props: {
              ...news,
              env: {
                ...bindingEnv,
                ...alchemyEnv,
                ...news.env,
              },
            },
            family,
            imageUri,
            taskRoleArn,
            executionRoleArn,
            logGroupName,
          });

          yield* session.note(taskDefinition.taskDefinitionArn!);
          return {
            taskDefinitionArn: taskDefinition.taskDefinitionArn!,
            taskFamily: family,
            containerName:
              taskDefinition.containerDefinitions?.[0]?.name ?? family,
            port: news.port ?? output?.port ?? 3000,
            imageUri,
            repositoryName,
            repositoryUri,
            taskRoleArn,
            taskRoleName,
            executionRoleArn,
            executionRoleName,
            logGroupName,
            logGroupArn,
            code: {
              hash,
            },
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* ecs
            .deregisterTaskDefinition({
              taskDefinition: output.taskDefinitionArn,
            })
            .pipe(Effect.catchTag("ClientException", () => Effect.void));

          yield* ecr
            .deleteRepository({
              repositoryName: output.repositoryName,
              force: true,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );

          yield* logs
            .deleteLogGroup({
              logGroupName: output.logGroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* iam
            .listRolePolicies({
              RoleName: output.taskRoleName,
            })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.PolicyNames ?? []).map((policyName) =>
                    iam
                      .deleteRolePolicy({
                        RoleName: output.taskRoleName,
                        PolicyName: policyName,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
            );

          for (const roleName of [
            output.taskRoleName,
            output.executionRoleName,
          ]) {
            yield* iam
              .listAttachedRolePolicies({
                RoleName: roleName,
              })
              .pipe(
                Effect.flatMap((policies) =>
                  Effect.all(
                    (policies.AttachedPolicies ?? []).map((policy) =>
                      iam
                        .detachRolePolicy({
                          RoleName: roleName,
                          PolicyArn: policy.PolicyArn!,
                        })
                        .pipe(
                          Effect.catchTag(
                            "NoSuchEntityException",
                            () => Effect.void,
                          ),
                        ),
                    ),
                  ),
                ),
              );
            yield* iam
              .deleteRole({
                RoleName: roleName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }),
      };
    }),
  );
