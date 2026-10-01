import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  ExtensionOperationError,
  OrchestrationDispatchCommandError,
  ProjectId,
} from "@t3tools/contracts";
import { projectsCloneApi } from "@t3tools/extension-sdk/catalogue";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import {
  getAddProjectInitialQuery,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { ProjectCloneTracker, type ProjectCloneHooks } from "../project/ProjectCloneTracker.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import {
  isSafeRepositoryIdentifier,
  isSafeRepositoryRemote,
} from "../sourceControl/remoteValidation.ts";

import { lookupExtensionRepository } from "./repositoryLookup.ts";
import { ServerConfig } from "../config.ts";

const fail = (detail = "Project clone request is invalid or unavailable.") =>
  new ExtensionOperationError({
    operation: "projects.clone",
    detail,
  });
const startInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  destinationName: Schema.String.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/),
  ),
  remoteUrl: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  provider: Schema.optional(
    Schema.Literals(["github", "gitlab", "forgejo", "azure-devops", "bitbucket"]),
  ),
  repository: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  protocol: Schema.optional(Schema.Literals(["auto", "ssh", "https"])),
});
const actionInput = Schema.Struct({ projectId: ProjectId });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
  } catch {
    throw fail();
  }
};
const ownerPrefix = (callerId: string) =>
  `extension-clone-${NodeCrypto.createHash("sha256").update(callerId).digest("hex").slice(0, 24)}-`;

export function assertCloneAuthority(
  environmentId: string,
  context: ViewContext,
  metadata: HostApiInvocationMetadata,
  write: boolean,
) {
  const principal = metadata.principal;
  if (
    context.resource.environmentId !== environmentId ||
    !principal ||
    principal.environmentId !== environmentId ||
    !principal.scopes.includes(AuthOrchestrationReadScope) ||
    (write && !principal.scopes.includes(AuthOrchestrationOperateScope)) ||
    !metadata.assertAuthority
  )
    throw fail();
  return metadata.assertAuthority;
}

export const managedCloneDestination = Effect.fn("ProjectsClone.destination")(
  function* (baseDirectory: string | null | undefined, name: string) {
    yield* Effect.try({
      try: () => decode(startInput, { title: "Clone", destinationName: name }),
      catch: () => fail(),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (name !== getCloneDirectoryName(name) || /\.git$/i.test(name))
      return yield* fail("Choose a directory name without a .git suffix.");
    const root = path.resolve(expandHomePathWith(getAddProjectInitialQuery(baseDirectory), path));
    yield* fileSystem.makeDirectory(root, { recursive: true });
    const canonicalRoot = yield* fileSystem.realPath(root);
    const destination = path.join(canonicalRoot, name);
    const link = yield* Effect.exit(fileSystem.readLink(destination));
    if (Exit.isSuccess(link)) return yield* fail("Clone destination must not be a symbolic link.");
    if (yield* fileSystem.exists(destination)) {
      if ((yield* fileSystem.realPath(destination)) !== destination) return yield* fail();
    }
    return destination;
  },
  Effect.mapError((cause) =>
    Schema.is(ExtensionOperationError)(cause)
      ? cause
      : fail(
          "Clone destination is unavailable. Check the Add Project base directory and its permissions.",
        ),
  ),
);

export function createProjectsCloneApiProvider(dependencies: {
  readonly environmentId: string;
  readonly cwd: string;
  readonly discovery: Pick<SourceControlProviderRegistry["Service"], "get" | "repositoryHosts">;
  readonly destinationPath: (name: string) => Effect.Effect<string, Error>;
  readonly tracker: Pick<ProjectCloneTracker["Service"], "start" | "cancel" | "retry" | "stream">;
  readonly hooks: ProjectCloneHooks;
}): HostApiProvider {
  return {
    providerId: "host.projects-clone",
    definition: projectsCloneApi.definition,
    requiresRootAuthority: true,
    async invoke(method, input, context, signal, metadata) {
      const assertAuthority = assertCloneAuthority(
        dependencies.environmentId,
        context,
        metadata,
        true,
      );
      signal.throwIfAborted();
      await assertAuthority();
      if (method === "start") {
        const request = decode(startInput, input);
        if (
          request.title.trim().length === 0 ||
          (request.remoteUrl !== undefined
            ? request.provider !== undefined || request.repository !== undefined
            : request.provider === undefined || request.repository === undefined)
        )
          throw fail();
        if (
          request.destinationName !== getCloneDirectoryName(request.destinationName) ||
          /\.git$/i.test(request.destinationName)
        )
          throw fail("Choose a directory name without a .git suffix.");
        if (request.remoteUrl !== undefined && !isSafeRepositoryRemote(request.remoteUrl))
          throw fail(
            "Use an HTTPS or SSH clone URL without credentials, query parameters or fragments.",
          );
        if (
          request.provider !== undefined &&
          request.repository !== undefined &&
          !isSafeRepositoryIdentifier(request.provider, request.repository)
        )
          throw fail("Use a valid provider repository path, such as owner/name.");
        const repository =
          request.provider !== undefined && request.repository !== undefined
            ? await Effect.runPromise(
                lookupExtensionRepository(dependencies.discovery, {
                  provider: request.provider,
                  repository: request.repository,
                  cwd: dependencies.cwd,
                }),
                { signal },
              )
            : null;
        await assertAuthority();
        const destinationPath = await Effect.runPromise(
          dependencies.destinationPath(request.destinationName),
          { signal },
        );
        await assertAuthority();
        const cloneInput = {
          title: request.title,
          remoteUrl: repository
            ? request.protocol === "https"
              ? repository.url
              : repository.sshUrl
            : request.remoteUrl!,
        };
        const createdAt = await Effect.runPromise(
          DateTime.now.pipe(Effect.map(DateTime.formatIso)),
          { signal },
        );
        return Effect.runPromise(
          dependencies.tracker.start(
            {
              ...cloneInput,
              projectId: ProjectId.make(ownerPrefix(metadata.callerId) + NodeCrypto.randomUUID()),
              createdAt,
              destinationPath,
            },
            dependencies.hooks,
          ),
          { signal },
        );
      }
      if (method !== "cancel" && method !== "retry") throw fail();
      const request = decode(actionInput, input);
      if (!request.projectId.startsWith(ownerPrefix(metadata.callerId))) throw fail();
      await assertAuthority();
      const applied = await Effect.runPromise(dependencies.tracker[method](request.projectId), {
        signal,
      });
      return { applied };
    },
    subscribe(name, input, context, signal, metadata, resumeCursor) {
      if (name !== "subscribe" || resumeCursor !== undefined) throw fail();
      decode(Schema.Struct({}), input);
      const assertAuthority = assertCloneAuthority(
        dependencies.environmentId,
        context,
        metadata,
        false,
      );
      return (async function* () {
        await assertAuthority();
        signal.throwIfAborted();
        const iterator = Stream.toAsyncIterable(dependencies.tracker.stream)[
          Symbol.asyncIterator
        ]();
        const cancel = () => {
          void iterator.return?.().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          let initial = true;
          let previous: string | undefined;
          for (;;) {
            const next = await iterator.next();
            if (next.done || signal.aborted) return;
            await assertAuthority();
            const clones = next.value.filter((clone) =>
              clone.projectId.startsWith(ownerPrefix(metadata.callerId)),
            );
            clones.sort(
              (left, right) =>
                Number(right.phase === "running") - Number(left.phase === "running") ||
                right.sequence - left.sequence,
            );
            const bounded: typeof clones = [];
            let bytes = 0;
            for (const clone of clones) {
              const size = Buffer.byteLength(JSON.stringify(clone));
              if (bounded.length === 16 || bytes + size > 48 * 1024) break;
              bounded.push(clone);
              bytes += size;
            }
            const projected = JSON.stringify({
              clones: bounded,
              truncated: clones.length > bounded.length,
            });
            if (projected === previous) continue;
            previous = projected;
            yield {
              type: initial ? ("snapshot" as const) : ("data" as const),
              value: JSON.parse(projected),
            };
            initial = false;
          }
        } finally {
          signal.removeEventListener("abort", cancel);
          await iterator.return?.();
        }
      })();
    },
  };
}

export const makeProjectsCloneApiProvider = Effect.fn("ProjectsCloneApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  const engine = yield* OrchestrationEngineService;
  const identity = yield* RepositoryIdentityResolver;
  const git = yield* VcsStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const normalizerContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof normalizeDispatchCommand>>>();
  const hooks: ProjectCloneHooks = {
    createProject: (project) =>
      normalizeDispatchCommand({
        type: "project.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        projectId: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        createdAt: project.createdAt,
      }).pipe(
        Effect.provideContext(normalizerContext),
        Effect.flatMap(engine.dispatch),
        Effect.asVoid,
        Effect.mapError(
          () =>
            new OrchestrationDispatchCommandError({
              message: "The cloned project could not be created.",
            }),
        ),
      ),
    onCloned: (project) =>
      identity.resolve(project.workspaceRoot, { refresh: true }).pipe(
        Effect.andThen(
          engine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            projectId: project.projectId,
          }),
        ),
        Effect.andThen(git.refreshStatus(project.workspaceRoot)),
        Effect.ignoreCause({ log: true }),
      ),
  };
  return createProjectsCloneApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    cwd: (yield* ServerConfig).cwd,
    discovery: yield* SourceControlProviderRegistry,
    destinationPath: (name) =>
      settings.getSettings.pipe(
        Effect.flatMap((current) => managedCloneDestination(current.addProjectBaseDirectory, name)),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    tracker: yield* ProjectCloneTracker,
    hooks,
  });
});
