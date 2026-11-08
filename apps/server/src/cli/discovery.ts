import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  isListedThreadLineage,
  type ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Console from "effect/Console";
import * as Runtime from "effect/Runtime";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class DiscoveryServerNotRunningError extends Schema.TaggedError<DiscoveryServerNotRunningError>()(
  "DiscoveryServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

class DiscoveryProjectNotFoundError extends Schema.TaggedError<DiscoveryProjectNotFoundError>()(
  "DiscoveryProjectNotFoundError",
  { identifier: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `No T3 Code project matches '${this.identifier}'. Pass a project id or a path inside a project.`;
  }
}

export const DiscoveryCliError = Schema.Union([
  DiscoveryServerNotRunningError,
  DiscoveryProjectNotFoundError,
]);
const isDiscoveryCliError = Schema.is(DiscoveryCliError);

export const reportDiscoveryErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isDiscoveryCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

export const resolveDiscoveryProject = Effect.fn("cli.discovery.resolveProject")(function* <
  P extends {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  },
>(projects: ReadonlyArray<P>, identifier: string) {
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  // Stored roots keep the path the project was added with, which may pass
  // through a symlink (macOS /tmp), so both sides compare as real paths.
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(
    path.resolve(yield* HostProcess.WorkingDirectory, yield* expandHomePath(identifier)),
  );
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const containing = roots
    .filter(({ root }) => {
      const relative = path.relative(root, target);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    })
    .toSorted((left, right) => right.root.length - left.root.length)[0];
  if (containing === undefined) {
    return yield* new DiscoveryProjectNotFoundError({ identifier });
  }
  return containing.project;
});

const readSnapshot = Effect.fn("cli.discovery.readSnapshot")(function* (
  origin: string,
  token: string,
) {
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
  const headers = {
    authorization: `Bearer ${token}`,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  } as const;
  const [projects, shell] = yield* Effect.all([
    client.projects.snapshot({ headers }),
    client.orchestration.shellSnapshot({ headers, query: {} }),
  ]);
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const nowMs = yield* Clock.currentTimeMillis;
  // Keep settlement-service dependencies off the CLI help and startup paths.
  const { listItemFromShell } = yield* Effect.promise(
    () => import("../orchestration-v2/threadSummary.ts"),
  );
  const threads = shell.threads
    .filter((thread) => isListedThreadLineage(thread.lineage))
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
        right.id.localeCompare(left.id),
    )
    .map((thread) =>
      listItemFromShell(thread, formatThreadLink({ environmentId, threadId: thread.id }), nowMs),
    );
  return { projects: projects.projects.filter((project) => project.deletedAt === null), threads };
});
type DiscoverySnapshot = Effect.Success<ReturnType<typeof readSnapshot>>;

export const withDiscoverySnapshot = Effect.fn("cli.discovery.withSnapshot")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (snapshot: DiscoverySnapshot) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(state))
      return yield* new DiscoveryServerNotRunningError({ baseDir: config.baseDir });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      auth.issueSession({ scopes: [AuthOrchestrationReadScope], label: "t3 discovery cli" }),
      (session) =>
        readSnapshot(state.value.origin, session.token).pipe(
          Effect.timeout("10 seconds"),
          Effect.flatMap(run),
        ),
      (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      Layer.merge(
        FetchHttpClient.layer,
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    ),
  );
});
