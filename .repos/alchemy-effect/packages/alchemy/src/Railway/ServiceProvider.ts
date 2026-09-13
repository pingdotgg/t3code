import type {
  Builder,
  DeploymentTriggersResponseEdgesItemNode,
  ProjectResponseServicesEdgesItemNode,
  RestartPolicyType,
  CreateServiceResponse,
  ServiceInstanceResponse,
  ServiceInstanceUpdateInput,
  ServiceResponse,
  UpdateServiceResponse,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../AlchemyContext.ts";
import { Unowned } from "../AdoptPolicy.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Stack } from "../Stack.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import { assertHostDisk, type MountSpec } from "./MountVolume.ts";
import { ownedProjects } from "./Project.ts";
import { attachVolumeToService, listServiceVolumes } from "./Volume.ts";
import {
  deleteOwnedServiceDomain,
  ensureServiceDomain,
  findServiceDomainById,
  type ServiceDomainRecord,
} from "./ServiceDomain.ts";
import {
  collectBindingState,
  createRailwayHostedSupport,
  DEFAULT_PORT,
  plainEnvValue,
  toEnvRecord,
} from "./hosted.ts";
import { RPC_TOKEN_ENV } from "./rpc-token.ts";
import { tarGzipDirectory } from "../Util/tarGzip.ts";
import {
  hashRailwayLocalContext,
  prepareRailwayLocalContext,
  resolveRailwayServiceSource,
  ServiceSourceInvalid,
  type RailwayLocalContextSource,
} from "./local-context.ts";
import { uploadDeployTarball } from "./Up.ts";
import { Service } from "./Service.ts";

export {
  ServiceContextPathInvalid,
  ServiceContextPathUnsupported,
  ServiceContextSymlinkUnsupported,
  ServiceContextTooLarge,
  ServiceDockerfileOutsideContext,
  ServiceDockerfilePathInvalid,
  ServiceImageOrMainRequired,
  ServiceSourceInvalid,
} from "./local-context.ts";

export class ServiceNotCreated extends Data.TaggedError(
  "Railway.ServiceNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class ServiceProjectRequired extends Data.TaggedError(
  "Railway.ServiceProjectRequired",
)<{
  message: string;
}> {}

export class ServiceDeployFailed extends Data.TaggedError(
  "Railway.ServiceDeployFailed",
)<{
  serviceId: string;
  status: string;
  deploymentId: string | undefined;
  logs: string;
}> {
  override get message() {
    return this.logs.length > 0
      ? `Service deploy ${this.status}: ${this.logs}`
      : `Service deploy ${this.status}`;
  }
}

class ServicePending extends Data.TaggedError("Railway.ServicePending")<{
  serviceId: string;
  status: string;
}> {}

class ServiceDeployPending extends Data.TaggedError(
  "Railway.ServiceDeployPending",
)<{
  serviceId: string;
  status: string;
}> {
  override get message() {
    return `deployment still ${this.status}`;
  }
}

type CloudService =
  | ServiceResponse
  | CreateServiceResponse
  | UpdateServiceResponse
  | ProjectResponseServicesEdgesItemNode;

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const isGoneService = (service: CloudService | undefined) =>
  service === undefined || service.deletedAt != null;

const isGoneInstance = (instance: ServiceInstanceResponse | undefined) =>
  instance === undefined || instance.deletedAt != null;

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const getById = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) => (isGoneService(service) ? undefined : service)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const getInstance = (environmentId: string, serviceId: string) =>
  railway.serviceInstance({ environmentId, serviceId }).pipe(
    Effect.map((instance) => (isGoneInstance(instance) ? undefined : instance)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listProjectServices = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.services.edges
        .map((edge) => edge.node)
        .filter((node) => !isGoneService(node)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as ProjectResponseServicesEdgesItemNode[]),
    ),
  );

const findByName = (projectId: string, name: string) =>
  listProjectServices(projectId).pipe(
    Effect.map((services) => services.find((service) => service.name === name)),
  );

const alreadyExists = (message: string) =>
  /already exists|already in use|duplicate/i.test(message);

const sameImage = (observed: string | null | undefined, desired: string) => {
  if (observed == null || observed.length === 0) return false;
  if (observed === desired) return true;
  if (observed === `${desired}:latest` || desired === `${observed}:latest`) {
    return true;
  }
  return (
    observed.endsWith(`/${desired}`) || observed.endsWith(`/${desired}:latest`)
  );
};

const deployReady = (status: string | undefined) =>
  status === "SUCCESS" || status === "SLEEPING";

const deployFailed = (status: string | undefined) =>
  status === "FAILED" || status === "CRASHED" || status === "REMOVED";

const undef = <T>(value: T | null | undefined): T | undefined =>
  value == null ? undefined : value;

const sameWatchPatterns = (
  observed: readonly string[] | null | undefined,
  desired: readonly string[] | undefined,
) => desired === undefined || deepEqual([...(observed ?? [])], [...desired]);

const samePreDeployCommand = (
  observed: unknown,
  desired: string | null | undefined,
) =>
  desired === undefined ||
  (desired === null
    ? observed == null || (Array.isArray(observed) && observed.length === 0)
    : observed === desired ||
      (Array.isArray(observed) &&
        observed.length === 1 &&
        observed[0] === desired));

const assignIfChanged = <K extends keyof ServiceInstanceUpdateInput>(
  input: ServiceInstanceUpdateInput,
  key: K,
  desired: ServiceInstanceUpdateInput[K] | undefined,
  observed: unknown,
): boolean => {
  if (desired === undefined) return false;
  if (
    desired === null
      ? observed == null
      : deepEqual(undef(observed as never), desired)
  ) {
    return false;
  }
  input[key] = desired;
  return true;
};

const instanceSettingsDelta = (input: {
  instance: ServiceInstanceResponse | undefined;
  sourceImage: string | undefined;
  sourceRepo: string | undefined;
  registryCredentials: { username: string; password: string } | undefined;
  props: {
    region?: string;
    rootDirectory?: string;
    buildCommand?: string;
    preDeploy?: { command: string | null };
    startCommand?: string;
    healthcheckPath?: string;
    healthcheck?: string;
    healthcheckTimeout?: number;
    cronSchedule?: string;
    restartPolicyType?: RestartPolicyType;
    restartPolicyMaxRetries?: number;
    drainingSeconds?: number;
    overlapSeconds?: number;
    sleepApplication?: boolean;
    dockerfilePath?: string | null;
    builder?: Builder;
    watchPatterns?: string[];
  };
}): ServiceInstanceUpdateInput | undefined => {
  const instance = input.instance;
  const delta: ServiceInstanceUpdateInput = {};
  let changed = false;

  if (input.sourceRepo !== undefined) {
    if (undef(instance?.source?.repo) !== input.sourceRepo) {
      delta.source = { repo: input.sourceRepo };
      changed = true;
    }
  } else if (
    input.sourceImage !== undefined &&
    !sameImage(instance?.source?.image, input.sourceImage)
  ) {
    delta.source = { image: input.sourceImage };
    changed = true;
  }

  if (input.registryCredentials !== undefined) {
    delta.registryCredentials = input.registryCredentials;
    changed = true;
  }

  changed =
    assignIfChanged(delta, "region", input.props.region, instance?.region) ||
    changed;
  changed =
    assignIfChanged(
      delta,
      "rootDirectory",
      input.props.rootDirectory,
      instance?.rootDirectory,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "buildCommand",
      input.props.buildCommand,
      instance?.buildCommand,
    ) || changed;
  const preDeployCommand =
    input.props.preDeploy === undefined
      ? undefined
      : input.props.preDeploy.command;
  if (
    preDeployCommand !== undefined &&
    !samePreDeployCommand(instance?.preDeployCommand, preDeployCommand)
  ) {
    // Railway's GraphQL field is `[String]`. `null` is a no-op; `[]` clears.
    delta.preDeployCommand =
      preDeployCommand === null ? [] : [preDeployCommand];
    changed = true;
  }
  changed =
    assignIfChanged(
      delta,
      "startCommand",
      input.props.startCommand,
      instance?.startCommand,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "healthcheckPath",
      input.props.healthcheckPath ?? input.props.healthcheck,
      instance?.healthcheckPath,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "healthcheckTimeout",
      input.props.healthcheckTimeout,
      instance?.healthcheckTimeout,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "cronSchedule",
      input.props.cronSchedule,
      instance?.cronSchedule,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "restartPolicyType",
      input.props.restartPolicyType,
      instance?.restartPolicyType,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "restartPolicyMaxRetries",
      input.props.restartPolicyMaxRetries,
      instance?.restartPolicyMaxRetries,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "drainingSeconds",
      input.props.drainingSeconds,
      instance?.drainingSeconds,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "overlapSeconds",
      input.props.overlapSeconds,
      instance?.overlapSeconds,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "sleepApplication",
      input.props.sleepApplication,
      instance?.sleepApplication,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "dockerfilePath",
      input.props.dockerfilePath,
      instance?.dockerfilePath,
    ) || changed;
  changed =
    assignIfChanged(delta, "builder", input.props.builder, instance?.builder) ||
    changed;

  const watchPatterns = input.props.watchPatterns;
  if (
    watchPatterns !== undefined &&
    !sameWatchPatterns(instance?.watchPatterns, watchPatterns)
  ) {
    delta.watchPatterns = watchPatterns;
    changed = true;
  }

  // `serviceInstanceUpdate` defaults `numReplicas` to 1 when omitted.
  // Pass through the observed count so a dashboard/CLI scale is not
  // reset on an unrelated settings update.
  if (changed && instance?.numReplicas != null) {
    delta.numReplicas = instance.numReplicas;
  }

  return changed ? delta : undefined;
};

const listDeploymentTriggers = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway.deploymentTriggers
    .items({
      projectId,
      environmentId,
      serviceId,
      first: 50,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((triggers) => Array.from(triggers)),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed([] as DeploymentTriggersResponseEdgesItemNode[]),
      ),
    );

const syncBranch = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  repo: string;
  branch: string | undefined;
}) {
  if (input.branch === undefined) return false;
  const triggers = yield* listDeploymentTriggers(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  const current = triggers[0];
  if (current === undefined) {
    yield* railway.deploymentTriggerCreate({
      input: {
        branch: input.branch,
        environmentId: input.environmentId,
        projectId: input.projectId,
        provider: "github",
        repository: input.repo,
        serviceId: input.serviceId,
      },
    });
    return true;
  }
  const branchChanged = current.branch !== input.branch;
  const repoChanged = current.repository !== input.repo;
  if (!branchChanged && !repoChanged) return false;
  yield* railway.deploymentTriggerUpdate({
    id: current.id,
    input: {
      ...(branchChanged ? { branch: input.branch } : {}),
      ...(repoChanged ? { repository: input.repo } : {}),
    },
  });
  return true;
});

const clearDeploymentTriggers = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
}) {
  const triggers = yield* listDeploymentTriggers(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  const github = triggers.filter((trigger) => trigger.provider === "github");
  yield* Effect.forEach(github, (trigger) =>
    railway.deploymentTriggerDelete({ id: trigger.id }),
  );
  return github.length > 0;
});

const syncAutoUpdates = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  enabled: boolean | undefined;
}) {
  if (input.enabled === undefined) return;
  const status = yield* railway
    .serviceInstanceAutoDeployStatus({
      environmentId: input.environmentId,
      projectId: input.projectId,
      serviceId: input.serviceId,
    })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );
  if (status?.enabled === input.enabled) return;
  yield* railway.serviceInstanceAutoDeployUpdate({
    input: {
      enabled: input.enabled,
      environmentId: input.environmentId,
      projectId: input.projectId,
      serviceId: input.serviceId,
    },
  });
});

const waitForInstance = (environmentId: string, serviceId: string) =>
  getInstance(environmentId, serviceId).pipe(
    Effect.flatMap((instance) => {
      if (instance === undefined) {
        return Effect.fail(
          new ServicePending({ serviceId, status: "creating" }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.ServicePending",
      // serviceCreate fans the instance out to each environment
      // asynchronously; under full-suite load the fan-out can take minutes.
      times: 60,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.ServicePending", () =>
      getInstance(environmentId, serviceId),
    ),
  );

const fetchDeployLogs = (deploymentId: string | undefined) =>
  deploymentId === undefined || deploymentId.length === 0
    ? Effect.succeed("")
    : railway.deploymentLogs({ deploymentId, limit: 80 }).pipe(
        Effect.map((rows) =>
          rows
            .map((row) =>
              row.severity != null
                ? `[${row.severity}] ${row.message}`
                : row.message,
            )
            .join("\n"),
        ),
        Effect.orElseSucceed(() => ""),
      );

const waitForDeployment = (environmentId: string, serviceId: string) =>
  Effect.gen(function* () {
    const instance = yield* getInstance(environmentId, serviceId);
    const latest = instance?.latestDeployment;
    const status = latest?.status;
    if (status !== undefined && deployFailed(status)) {
      const logs = yield* fetchDeployLogs(latest?.id);
      return yield* new ServiceDeployFailed({
        serviceId,
        status,
        deploymentId: latest?.id,
        logs,
      });
    }
    if (instance !== undefined && deployReady(status)) {
      return instance;
    }
    return yield* new ServiceDeployPending({
      serviceId,
      status: status ?? "pending",
    });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Railway.ServiceDeployPending",
      // Queued builds under full-suite load can exceed 3 minutes — allow ~8.
      times: 96,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

type DeployRef = {
  id: string;
  status: string | undefined;
};

const asDeployRef = (
  row: { id: string; status?: string | null } | undefined,
): DeployRef | undefined =>
  row === undefined
    ? undefined
    : { id: row.id, status: row.status ?? undefined };

const matchUploadedDeployment = (
  instance: ServiceInstanceResponse | undefined,
  deploymentId: string,
): DeployRef | undefined => {
  const latest = instance?.latestDeployment;
  if (latest?.id === deploymentId) return asDeployRef(latest);
  return asDeployRef(
    (instance?.activeDeployments ?? []).find(
      (deployment) => deployment.id === deploymentId,
    ),
  );
};

const listUploadedDeployment = (input: {
  deploymentId: string;
  serviceId: string;
  environmentId: string;
}) =>
  railway.deployments
    .items({
      first: 10,
      input: {
        serviceId: input.serviceId,
        environmentId: input.environmentId,
      },
    })
    .pipe(
      Stream.filter((row) => row.id === input.deploymentId),
      Stream.take(1),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.succeed(undefined),
      }),
      Effect.catchTag(
        ["NotFound", "UnknownRailwayError", "RailwayParseError"],
        () => Effect.succeed(undefined),
      ),
    );

const waitForDeploymentById = (input: {
  deploymentId: string;
  serviceId: string;
  environmentId: string;
}) =>
  Effect.gen(function* () {
    // Poll the instance, not `deployment(id)`. Distilled's deployment
    // query is a huge nested selection that 404s/times out for /up ids;
    // `serviceInstance.latestDeployment` is the same record the rest of
    // reconcile already uses. The placeholder `hashicorp/http-echo`
    // deploy often FAILED (wrong port / no `/health`) before `railway up`
    // replaces it — do not inherit that FAILED onto this wait.
    const instance = yield* getInstance(input.environmentId, input.serviceId);
    const match =
      matchUploadedDeployment(instance, input.deploymentId) ??
      asDeployRef(yield* listUploadedDeployment(input));
    if (match === undefined) {
      return yield* new ServiceDeployPending({
        serviceId: input.serviceId,
        status: "pending",
      });
    }
    const status = match.status;
    if (status !== undefined && deployFailed(status)) {
      const logs = yield* fetchDeployLogs(match.id);
      return yield* new ServiceDeployFailed({
        serviceId: input.serviceId,
        status,
        deploymentId: match.id,
        logs,
      });
    }
    if (instance !== undefined && deployReady(status)) {
      return instance;
    }
    return yield* new ServiceDeployPending({
      serviceId: input.serviceId,
      status: status ?? "pending",
    });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Railway.ServiceDeployPending",
      times: 90,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.catchTag("Railway.ServiceDeployPending", (pending) =>
      Effect.gen(function* () {
        const instance = yield* getInstance(
          input.environmentId,
          input.serviceId,
        );
        const match =
          matchUploadedDeployment(instance, input.deploymentId) ??
          asDeployRef(yield* listUploadedDeployment(input));
        const status = match?.status;
        if (
          match !== undefined &&
          status !== undefined &&
          deployFailed(status)
        ) {
          const logs = yield* fetchDeployLogs(match.id);
          return yield* new ServiceDeployFailed({
            serviceId: input.serviceId,
            status,
            deploymentId: match.id,
            logs,
          });
        }
        return yield* pending;
      }),
    ),
  );

const upsertVariable = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  name: string;
  value: string;
}) =>
  railway.upsertVariable({
    input: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      name: input.name,
      value: input.value,
      skipDeploys: true,
    },
  });

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const listVariableMap = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const syncEnv = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  desired: Record<string, string>;
}) {
  if (Object.keys(input.desired).length === 0) return false;
  const observed = yield* listVariableMap(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  let changed = false;
  for (const [name, value] of Object.entries(input.desired)) {
    if (observed[name] !== value) {
      yield* upsertVariable({
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        name,
        value,
      });
      changed = true;
    }
  }
  return changed;
});

const syncMounts = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  mounts: MountSpec[];
}) {
  for (const mount of input.mounts) {
    yield* attachVolumeToService({
      environmentId: input.environmentId,
      projectId: input.projectId,
      serviceId: input.serviceId,
      volumeId: mount.volumeId,
      mountPath: mount.path,
    });
  }
});

const toAttrs = (input: {
  service: CloudService;
  instance: ServiceInstanceResponse | undefined;
  domain: ServiceDomainRecord | undefined;
  projectId: string;
  environmentId: string;
  port: number | undefined;
  codeHash: string;
  rpcToken: string;
}): Service["Attributes"] => ({
  serviceId: input.service.id,
  name: input.service.name,
  projectId: input.projectId,
  environmentId: input.environmentId,
  image: input.instance?.source?.image ?? undefined,
  repo: input.instance?.source?.repo ?? undefined,
  healthcheckPath: input.instance?.healthcheckPath ?? undefined,
  healthcheckTimeout: input.instance?.healthcheckTimeout ?? undefined,
  replicas: input.instance?.numReplicas ?? undefined,
  buildCommand: input.instance?.buildCommand ?? undefined,
  startCommand: input.instance?.startCommand ?? undefined,
  cronSchedule: input.instance?.cronSchedule ?? undefined,
  rootDirectory: input.instance?.rootDirectory ?? undefined,
  region: input.instance?.region ?? undefined,
  port: input.port,
  url: input.domain?.url,
  domain: input.domain?.domain,
  dnsName: `${input.service.name}.railway.internal`,
  rpcToken: input.rpcToken,
  domainId: input.domain?.id,
  deploymentId: input.instance?.latestDeployment?.id,
  deploymentStatus: input.instance?.latestDeployment?.status,
  code: { hash: input.codeHash },
});

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const { dotAlchemy } = yield* AlchemyContext;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const hosted = createRailwayHostedSupport({
        stackName: stack.name,
        stage: stack.stage,
        virtualEntryPlugin,
        dotAlchemy,
      });

      return Service.Provider.of({
        stables: ["serviceId", "projectId", "environmentId"],
        nuke: { dependsOn: ["Railway.Project"] },

        diff: Effect.fn(function* ({ news, output }) {
          if (news === undefined || !isResolved(news)) return undefined;
          if (output === undefined) return undefined;
          const nextProject = projectIdOf(news.project);
          const projectChanged =
            nextProject !== undefined && nextProject !== output.projectId;
          const nextEnv = environmentIdOf(news.environment);
          const environmentChanged =
            nextEnv !== undefined && nextEnv !== output.environmentId;
          if (projectChanged || environmentChanged) {
            return { action: "replace" as const };
          }
          const source = yield* resolveRailwayServiceSource(news);
          if (source.mode === "main") {
            const hash = yield* hosted.hash({
              main: source.main,
              handler: news.handler,
              port: news.port,
              image: news.image,
              env: news.env,
              isExternal: news.isExternal,
              build: news.build,
              extraFiles: news.extraFiles,
            });
            if (hash !== output.code.hash) {
              return { action: "update" as const };
            }
          } else if (source.mode === "context") {
            const hash = yield* hashRailwayLocalContext(source);
            if (hash !== output.code.hash) {
              return { action: "update" as const };
            }
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const projectId =
            output?.projectId ??
            (olds !== undefined ? projectIdOf(olds.project) : undefined);
          const environmentId =
            output?.environmentId ??
            (olds !== undefined
              ? (environmentIdOf(olds.environment) ??
                environmentIdOf(olds.project))
              : undefined);
          const name = yield* resolveName(id, olds?.name, output?.name);
          const byId =
            output?.serviceId !== undefined && output.serviceId.length > 0
              ? yield* getById(output.serviceId)
              : undefined;
          const found =
            byId ??
            (projectId !== undefined
              ? yield* findByName(projectId, name)
              : undefined);
          if (found === undefined) return undefined;
          const resolvedProjectId = projectIdOf(found) ?? projectId ?? "";
          const resolvedEnvId =
            environmentId ??
            environmentIdOf(olds?.project) ??
            output?.environmentId ??
            "";
          const instance =
            resolvedEnvId.length > 0
              ? yield* getInstance(resolvedEnvId, found.id)
              : undefined;
          // A recorded domain id is the ownership boundary. Refresh an owned
          // domain, but do not claim a generated domain found during adoption.
          const domain =
            output?.domainId !== undefined &&
            resolvedProjectId.length > 0 &&
            resolvedEnvId.length > 0
              ? yield* findServiceDomainById({
                  projectId: resolvedProjectId,
                  environmentId: resolvedEnvId,
                  serviceId: found.id,
                  domainId: output.domainId,
                })
              : undefined;
          const attrs = toAttrs({
            service: found,
            instance,
            domain,
            projectId: resolvedProjectId,
            environmentId: resolvedEnvId,
            port: output?.port ?? olds?.port,
            codeHash: output?.code.hash ?? "",
            rpcToken: output?.rpcToken ?? "",
          });
          if (output !== undefined) {
            // Keep the recorded ownership id even if the live list lags.
            // Wiping it makes `publicDomain: false` a no-op.
            if (domain === undefined && output.domainId !== undefined) {
              return {
                ...attrs,
                domainId: output.domainId,
                domain: output.domain,
                url: output.url,
              };
            }
            return attrs;
          }
          return matchesAlchemyPhysicalName(found.name)
            ? attrs
            : Unowned(attrs);
        }),

        list: Effect.fn(function* () {
          const projects = yield* ownedProjects();
          const rows = yield* Effect.forEach(projects, (project) =>
            listProjectServices(project.projectId).pipe(
              Effect.map((services) =>
                services
                  .filter((service) => matchesAlchemyPhysicalName(service.name))
                  .map((service) =>
                    toAttrs({
                      service,
                      instance: undefined,
                      domain: undefined,
                      projectId: project.projectId,
                      environmentId: project.environmentId,
                      port: undefined,
                      codeHash: "",
                      rpcToken: "",
                    }),
                  ),
              ),
            ),
          );
          return rows.flat();
        }),

        // Circular Service↔Function RPC binds `dnsName` / `port` / `rpcToken`.
        // Those are knowable from the physical name and props; the cloud
        // service is created in reconcile (and re-synced in converge).
        precreate: Effect.fn(function* ({ id, news }) {
          const name = yield* resolveName(
            id,
            typeof news.name === "string" ? news.name : undefined,
          );
          const port = typeof news.port === "number" ? news.port : DEFAULT_PORT;
          return {
            serviceId: "",
            name,
            projectId: "",
            environmentId: "",
            image: undefined,
            repo: undefined,
            healthcheckPath: undefined,
            healthcheckTimeout: undefined,
            replicas: undefined,
            buildCommand: undefined,
            startCommand: undefined,
            cronSchedule: undefined,
            rootDirectory: undefined,
            region: undefined,
            port,
            url: undefined,
            domain: undefined,
            dnsName: `${name}.railway.internal`,
            rpcToken: plainEnvValue(news.rpcToken) ?? "",
            domainId: undefined,
            deploymentId: undefined,
            deploymentStatus: undefined,
            code: { hash: "" },
          } satisfies Service["Attributes"];
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          output,
          bindings,
          session,
        }) {
          const props = news;
          const projectId = projectIdOf(props.project) ?? output?.projectId;
          if (projectId === undefined) {
            return yield* new ServiceProjectRequired({
              message: "Service requires a resolved Railway.Project",
            });
          }
          const environmentId =
            environmentIdOf(props.environment) ??
            environmentIdOf(props.project) ??
            output?.environmentId;
          if (environmentId === undefined) {
            return yield* new ServiceProjectRequired({
              message:
                "Service requires a Railway environment (pass environment or a Project with environmentId)",
            });
          }
          const name = yield* resolveName(id, props.name, output?.name);
          const source = yield* resolveRailwayServiceSource(props);
          const hostedMain = source.mode === "main" ? source.main : undefined;
          const localContext: RailwayLocalContextSource | undefined =
            source.mode === "context" ? source : undefined;
          const bound = collectBindingState(bindings ?? []);
          yield* assertHostDisk({
            name,
            mounts: bound.mounts,
          });
          const port =
            hostedMain !== undefined
              ? (props.port ?? DEFAULT_PORT)
              : props.port;
          const rpcToken =
            plainEnvValue(props.rpcToken) ?? output?.rpcToken ?? "";
          const env = {
            ...bound.env,
            ...(hostedMain !== undefined ? hosted.alchemyEnv : {}),
            ...(port !== undefined ? { PORT: String(port) } : {}),
            ...toEnvRecord(props.env),
            [RPC_TOKEN_ENV]: rpcToken,
          };

          let sourceImage: string | undefined;
          let sourceRepo: string | undefined;
          let localPrepared:
            | {
                codeHash: string;
                dockerfilePath: string;
                tarball: Uint8Array;
              }
            | undefined;
          let codeHash = output?.code.hash ?? "";
          let hashed:
            | {
                bundled: {
                  files: ReadonlyArray<{
                    path: string;
                    content: string | Uint8Array;
                  }>;
                };
                dockerfile: string;
                codeHash: string;
                packageJson: string | undefined;
              }
            | undefined;
          if (source.mode === "main") {
            yield* (session?.note ?? ((_message: string) => Effect.void))(
              `Bundling ${id} program...`,
            );
            hashed = yield* hosted.computeCodeHash({
              main: source.main,
              handler: props.handler,
              port,
              image: props.image,
              env: props.env,
              isExternal: props.isExternal,
              build: props.build,
              extraFiles: props.extraFiles,
            });
            codeHash = hashed.codeHash;
          } else if (source.mode === "context") {
            localPrepared = yield* prepareRailwayLocalContext(source);
            codeHash = localPrepared.codeHash;
          } else if (source.mode === "image") {
            sourceImage = source.image;
          } else {
            sourceRepo = source.repo;
          }

          let current: CloudService | undefined =
            output?.serviceId !== undefined && output.serviceId.length > 0
              ? yield* getById(output.serviceId)
              : undefined;
          if (current === undefined) {
            current = yield* findByName(projectId, name);
          }

          if (current === undefined) {
            const created = yield* railway
              .createService({
                input: {
                  projectId,
                  environmentId,
                  name,
                  ...(sourceRepo !== undefined
                    ? { source: { repo: sourceRepo } }
                    : {
                        source: {
                          image: sourceImage ?? "hashicorp/http-echo",
                        },
                      }),
                  ...(sourceRepo !== undefined && props.branch !== undefined
                    ? { branch: props.branch }
                    : {}),
                },
              })
              .pipe(
                Effect.catchTag("RailwayValidationError", (e) =>
                  alreadyExists(e.message)
                    ? Effect.succeed(undefined)
                    : Effect.fail(e),
                ),
                Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
              );
            current = created ?? (yield* findByName(projectId, name));
          }

          if (current === undefined || isGoneService(current)) {
            return yield* new ServiceNotCreated({ name, projectId });
          }

          if (current.name !== name) {
            current = yield* railway.updateService({
              id: current.id,
              input: { name },
            });
          }

          // The service instance must exist in this environment before a
          // domain can be generated (`railway domain` / Terraform both
          // operate on a live service instance). Extra non-fork
          // environments lag — `serviceCreate` fans out to every
          // non-fork env and `serviceInstance` 404s until it lands.
          let instance = yield* waitForInstance(environmentId, current.id);

          const publicDomain = props.publicDomain !== false;
          let domain: ServiceDomainRecord | undefined;
          if (publicDomain) {
            // Railway's generated-domain API refuses a service that already
            // has PORT (or other env) set — it returns "please try again"
            // forever. Create the hostname on a bare service, then sync env.
            yield* (session?.note ?? ((_message: string) => Effect.void))(
              `Creating service domain for ${id}...`,
            );
            domain = yield* ensureServiceDomain({
              projectId,
              environmentId,
              serviceId: current.id,
              domainId: output?.domainId ?? null,
            });
          } else {
            // Only the recorded generated domain belongs to this resource.
            // Adoption does not populate domainId/domain, so a foreign
            // domain stays. Null the environment-config key — GraphQL
            // delete alone is not enough; Railway recreates from config.
            yield* deleteOwnedServiceDomain({
              projectId,
              environmentId,
              serviceId: current.id,
              domainId: output?.domainId,
              domain: output?.domain,
            });
          }

          const attached = yield* listServiceVolumes(
            environmentId,
            projectId,
            current.id,
          );
          yield* assertHostDisk({
            name,
            mounts: [
              ...bound.mounts,
              ...attached.map((row) => ({
                volumeId: row.volumeId,
                path: row.mountPath,
              })),
            ],
          });
          let needsDeploy = false;
          let localSourceChanged =
            localContext !== undefined &&
            (instance?.source?.repo != null || instance?.source?.image != null);

          if (localSourceChanged) {
            yield* railway.disconnectService({ id: current.id });
            needsDeploy = true;
            instance =
              (yield* getInstance(environmentId, current.id)) ?? instance;
          }

          const leavingContext =
            olds?.context !== undefined && olds.context.length > 0;
          const clearsDockerfilePath =
            leavingContext &&
            (source.mode === "image" ||
              (source.mode === "repo" && props.dockerfilePath === undefined));
          const dockerfilePath =
            localPrepared?.dockerfilePath ??
            (clearsDockerfilePath ? null : props.dockerfilePath);
          const instanceDelta = instanceSettingsDelta({
            instance,
            sourceImage,
            sourceRepo,
            registryCredentials: undefined,
            props: {
              ...props,
              dockerfilePath,
              // Effect-native images must answer HTTP before Railway
              // stamps SUCCESS — otherwise waitForDeploymentById returns
              // while `/up` is still building and public GET hangs.
              // Default `/health`, not `/`: user fetch handlers often 404
              // `/` (BucketApi) and Railway treats that as FAILED.
              healthcheckPath:
                props.healthcheckPath ??
                props.healthcheck ??
                (hostedMain !== undefined ? "/health" : undefined),
              healthcheckTimeout:
                props.healthcheckTimeout ??
                (hostedMain !== undefined ? 300 : undefined),
            },
          });
          if (instanceDelta !== undefined) {
            yield* railway.updateServiceInstance({
              environmentId,
              serviceId: current.id,
              input: instanceDelta,
            });
            needsDeploy = true;
            instance =
              (yield* getInstance(environmentId, current.id)) ?? instance;
          }

          if (sourceRepo !== undefined) {
            const branchChanged = yield* syncBranch({
              projectId,
              environmentId,
              serviceId: current.id,
              repo: sourceRepo,
              branch: props.branch,
            });
            if (branchChanged) needsDeploy = true;
          }

          if (localContext !== undefined) {
            const triggersChanged = yield* clearDeploymentTriggers({
              projectId,
              environmentId,
              serviceId: current.id,
            });
            if (triggersChanged) {
              needsDeploy = true;
              localSourceChanged = true;
            }
          }

          yield* syncAutoUpdates({
            projectId,
            environmentId,
            serviceId: current.id,
            enabled: props.autoUpdates,
          });

          const envChanged = yield* syncEnv({
            projectId,
            environmentId,
            serviceId: current.id,
            desired: env,
          });
          if (envChanged) needsDeploy = true;

          if (publicDomain && port !== undefined) {
            domain = yield* ensureServiceDomain({
              projectId,
              environmentId,
              serviceId: current.id,
              domainId: domain?.id,
              targetPort: port,
            });
          }

          yield* syncMounts({
            environmentId,
            projectId,
            serviceId: current.id,
            mounts: bound.mounts,
          });

          const uploadSource =
            hostedMain !== undefined || localContext !== undefined;
          const latestOk = deployReady(instance?.latestDeployment?.status);
          const shouldUpload =
            uploadSource &&
            (codeHash !== output?.code.hash || !latestOk || localSourceChanged);

          if (shouldUpload) {
            const note = session?.note ?? ((_message: string) => Effect.void);
            yield* note(`Preparing ${id} build context...`);
            const tarball =
              localPrepared !== undefined
                ? localPrepared.tarball
                : hostedMain !== undefined && hashed !== undefined
                  ? yield* hosted
                      .writeContext({
                        id,
                        props: {
                          main: hostedMain,
                          handler: props.handler,
                          port,
                          image: props.image,
                          env: props.env,
                          isExternal: props.isExternal,
                          build: props.build,
                          extraFiles: props.extraFiles,
                        },
                        hashed,
                      })
                      .pipe(Effect.flatMap(tarGzipDirectory))
                  : yield* new ServiceSourceInvalid({
                      message: "Railway.Service upload source was not prepared",
                    });
            yield* note(`Uploading ${id} build context to Railway...`);
            const uploaded = yield* uploadDeployTarball({
              projectId,
              environmentId,
              serviceId: current.id,
              tarball,
              message: `alchemy ${id} ${codeHash}`,
            });
            yield* note(`Queued Railway build ${uploaded.deploymentId}`);
            instance =
              (yield* waitForDeploymentById({
                deploymentId: uploaded.deploymentId,
                serviceId: current.id,
                environmentId,
              })) ?? instance;
          } else if (
            !uploadSource &&
            (needsDeploy || instance?.latestDeployment == null)
          ) {
            yield* railway
              .serviceInstanceDeployV2({
                environmentId,
                serviceId: current.id,
              })
              .pipe(
                Effect.catchTag("RailwayValidationError", () => Effect.void),
              );
            instance =
              sourceRepo !== undefined
                ? ((yield* getInstance(environmentId, current.id)) ?? instance)
                : ((yield* waitForDeployment(environmentId, current.id)) ??
                  instance);
          } else if (uploadSource && needsDeploy) {
            yield* railway
              .serviceInstanceDeployV2({
                environmentId,
                serviceId: current.id,
              })
              .pipe(
                Effect.catchTag("RailwayValidationError", () => Effect.void),
              );
            instance =
              (yield* waitForDeployment(environmentId, current.id)) ?? instance;
          }

          return toAttrs({
            service: current,
            instance,
            domain,
            projectId,
            environmentId,
            port,
            codeHash,
            rpcToken,
          });
        }),

        delete: Effect.fn(function* ({ output }) {
          const serviceId = output.serviceId;
          if (serviceId.length === 0) return;
          yield* railway
            .deleteService({
              id: serviceId,
              ...(output.environmentId.length > 0
                ? { environmentId: output.environmentId }
                : {}),
            })
            .pipe(
              Effect.catchTag(
                ["RailwayNotFound", "NotFound"],
                () => Effect.void,
              ),
            );
          yield* getById(serviceId).pipe(
            Effect.map((service) => service === undefined),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (gone) => gone,
              times: 8,
            }),
          );
        }),
      });
    }),
  );
