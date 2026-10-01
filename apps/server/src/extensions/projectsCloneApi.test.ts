import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  type ProjectCloneSnapshot,
} from "@t3tools/contracts";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { createProjectsCloneApiProvider, managedCloneDestination } from "./projectsCloneApi.ts";

const context: ViewContext = {
  resource: { namespace: "test", id: "clone", environmentId: "env" },
  client: "test",
};
const signal = new AbortController().signal;
const metadata = (provider: HostApiProvider, callerId = "caller") => ({
  callId: "call",
  rootCallerId: callerId,
  callerId,
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: {
    kind: "environment-session" as const,
    id: "session",
    environmentId: "env",
    cwd: "/host",
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  },
  assertAuthority: async () => {},
});

function fixture(stream: Stream.Stream<readonly ProjectCloneSnapshot[]> = Stream.make([])) {
  const calls: unknown[] = [];
  const provider = createProjectsCloneApiProvider({
    environmentId: "env",
    cwd: "/host",
    discovery: {
      repositoryHosts: () => Effect.succeed(["github.com"]),
      get: (kind) => {
        const host = {
          github: "github.com",
          gitlab: "gitlab.com",
          forgejo: "forge.example",
          "azure-devops": "dev.azure.com",
          bitbucket: "bitbucket.org",
          unknown: "unknown",
        }[kind];
        return Effect.succeed({
          kind,
          getRepositoryCloneUrls: () =>
            Effect.succeed({
              nameWithOwner: "alex/repo",
              url: `https://${host}/alex/repo.git`,
              sshUrl: `git@${host}:alex/repo.git`,
              repositoryHost: host,
            }),
        } as unknown as import("../sourceControl/SourceControlProvider.ts").SourceControlProvider["Service"]);
      },
    },
    destinationPath: (name) => Effect.succeed(`/managed/projects/${name}`),
    tracker: {
      start: (input) => {
        calls.push(input);
        return Effect.succeed({
          projectId: input.projectId,
          cwd: input.destinationPath,
          remoteUrl: "https://github.com/alex/repo.git",
          repository: null,
        });
      },
      cancel: (projectId) => {
        calls.push(projectId);
        return Effect.succeed(true);
      },
      retry: () => Effect.succeed(true),
      stream,
    },
    hooks: { createProject: () => Effect.void, onCloned: () => Effect.void },
  });
  return { provider, calls };
}

it("does not emit unchanged installation snapshots for unrelated native clone updates", async () => {
  const { provider } = fixture(Stream.make([], [], []));
  const events = [];
  for await (const event of provider.subscribe!(
    "subscribe",
    {},
    context,
    signal,
    metadata(provider),
  ))
    events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "snapshot", value: { clones: [], truncated: false } });
});

it("keeps clone snapshots below the stream broker's byte limit", async () => {
  let projectId = ProjectId.make("pending");
  const snapshot = (): ProjectCloneSnapshot => ({
    projectId,
    remoteUrl: "https://host/" + "x".repeat(1800),
    destinationPath: "/managed/" + "x".repeat(1800),
    repository: {
      provider: "github",
      nameWithOwner: "x".repeat(1800),
      url: "https://host/" + "x".repeat(1800),
      sshUrl: "git@host:" + "x".repeat(1800),
    },
    phase: "running",
    stage: "connecting",
    percent: null,
    detail: null,
    error: null,
    startedAt: "2026-09-30T00:00:00.000Z",
    endedAt: null,
    sequence: 1,
  });
  const provider = createProjectsCloneApiProvider({
    environmentId: "env",
    cwd: "/host",
    discovery: {
      repositoryHosts: () => Effect.succeed([]),
      get: () => Effect.die("Unexpected lookup"),
    },
    destinationPath: () => Effect.succeed("/managed/repo"),
    tracker: {
      start: (input) => {
        projectId = input.projectId;
        return Effect.succeed({
          projectId,
          cwd: input.destinationPath,
          remoteUrl: input.remoteUrl!,
          repository: null,
        });
      },
      cancel: () => Effect.succeed(true),
      retry: () => Effect.succeed(true),
      stream: Stream.suspend(() =>
        Stream.make(
          Array.from({ length: 17 }, (_, index) => ({
            ...snapshot(),
            projectId: ProjectId.make(`${projectId}-${index}`),
            phase: index === 16 ? ("running" as const) : ("failed" as const),
            sequence: index + 1,
          })),
        ),
      ),
    },
    hooks: { createProject: () => Effect.void, onCloned: () => Effect.void },
  });
  await provider.invoke(
    "start",
    { title: "Repo", destinationName: "repo", remoteUrl: "https://host/repo" },
    context,
    signal,
    metadata(provider),
  );
  for await (const event of provider.subscribe!(
    "subscribe",
    {},
    context,
    signal,
    metadata(provider),
  )) {
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(64 * 1024);
    expect(event.value).toMatchObject({ truncated: true });
    expect(event.value).toMatchObject({
      clones: expect.arrayContaining([expect.objectContaining({ phase: "running", sequence: 17 })]),
    });
  }
});

it("starts the native tracked clone with host-minted project identity and managed destination", async () => {
  const { provider, calls } = fixture();
  const result = await provider.invoke(
    "start",
    { title: "Repo", remoteUrl: "https://github.com/alex/repo.git", destinationName: "repo" },
    context,
    signal,
    metadata(provider),
  );
  expect(result).toMatchObject({ cwd: "/managed/projects/repo" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ title: "Repo", destinationPath: "/managed/projects/repo" });
});

it.each(["github", "gitlab", "forgejo", "azure-devops", "bitbucket"] as const)(
  "refuses unconfigured %s repository hosts before native clone effects",
  async (source) => {
    for (const repository of [
      "attacker.tld/o/n",
      "1.2.3.4/o/n",
      "https://attacker.tld/o/n",
      "ssh://attacker.tld/o/n",
    ]) {
      const { provider, calls } = fixture();
      await expect(
        provider.invoke(
          "start",
          { title: "Repo", destinationName: "repo", provider: source, repository },
          context,
          signal,
          metadata(provider),
        ),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  },
);

it.each([
  "ssh://ho\nst/x",
  "\tssh://host/x",
  "https://host/x\u0000",
  "git@host:x\u0000y",
  "https:host/x",
  "https://host\\@-x/y",
])("refuses parser-confusing remote %s", async (remoteUrl) => {
  const { provider, calls } = fixture();
  await expect(
    provider.invoke(
      "start",
      { title: "Repo", destinationName: "repo", remoteUrl },
      context,
      signal,
      metadata(provider),
    ),
  ).rejects.toThrow();
  expect(calls).toEqual([]);
});

it.each(["../escape", "/absolute", "..", "a/b", "a\\b", "repo.", "repo.git", "repo.GIT"])(
  "refuses destination %s before native effects",
  async (destinationName) => {
    const { provider, calls } = fixture();
    await expect(
      provider.invoke(
        "start",
        { title: "Repo", remoteUrl: "https://github.com/alex/repo.git", destinationName },
        context,
        signal,
        metadata(provider),
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  },
);

it.each([
  "file:///private/repo",
  "ext::git clone x",
  "-u",
  "-cfoo.x@h:y.z=1",
  "-uX@h:y",
  "ssh://-oProxyCommand=x/y",
  "git@-host:repo.git",
  "ssh://-user@host/repo.git",
  "ssh://%2Duser@host/repo.git",
  "https://user:secret@github.com/repo",
  "https://github.com/repo?token=secret",
])("refuses unsafe clone transport", async (remoteUrl) => {
  const { provider, calls } = fixture();
  await expect(
    provider.invoke(
      "start",
      { title: "Repo", remoteUrl, destinationName: "repo" },
      context,
      signal,
      metadata(provider),
    ),
  ).rejects.toThrow();
  expect(calls).toEqual([]);
});

it.each(["github", "gitlab", "forgejo", "azure-devops", "bitbucket"] as const)(
  "refuses option-shaped or malformed %s repository identifiers before cloning",
  async (source) => {
    for (const repository of [
      "--web",
      "-owner/repo",
      "owner/repo\n--web",
      "owner/repo;--web",
      "owner/../repo",
    ]) {
      const { provider, calls } = fixture();
      await expect(
        provider.invoke(
          "start",
          {
            title: "Repo",
            destinationName: "repo",
            provider: source,
            repository,
          },
          context,
          signal,
          metadata(provider),
        ),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  },
);

it.each([
  ["github", "alex/.github"],
  ["github", "alex/-repo"],
  ["github", "https://github.com/alex/.github"],
  ["github", "git@github.com:alex/repo"],
  ["github", "https://github.com/alex/repo/"],
  ["gitlab", "group/subgroup/repo"],
  ["forgejo", "alex/.config"],
  ["azure-devops", "My Repo"],
  ["azure-devops", "Group/Project (Team)/Repo & Tools"],
  ["azure-devops", "Gröup/Project/My Repo"],
  ["bitbucket", "team/repo"],
] as const)("preserves valid %s repository identifier %s", async (source, repository) => {
  const { provider, calls } = fixture();
  await provider.invoke(
    "start",
    { title: "Repo", destinationName: "repo", provider: source, repository },
    context,
    signal,
    metadata(provider),
  );
  const host = {
    github: "github.com",
    gitlab: "gitlab.com",
    forgejo: "forge.example",
    "azure-devops": "dev.azure.com",
    bitbucket: "bitbucket.org",
  }[source];
  expect(calls).toEqual([expect.objectContaining({ remoteUrl: `git@${host}:alex/repo.git` })]);
});

it("explains invalid clone URLs and destination names without echoing the input", async () => {
  const { provider } = fixture();
  await expect(
    provider.invoke(
      "start",
      { title: "Repo", destinationName: "repo", remoteUrl: "https://user:secret@host/repo" },
      context,
      signal,
      metadata(provider),
    ),
  ).rejects.toThrow(/HTTPS or SSH clone URL without credentials/);
  await expect(
    provider.invoke(
      "start",
      { title: "Repo", destinationName: "repo.git", remoteUrl: "https://host/repo" },
      context,
      signal,
      metadata(provider),
    ),
  ).rejects.toThrow(/directory name without a .git suffix/);
});

it.effect("resolves the native configured clone root and home fallback", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const [base, expected] of [
      ["", NodeOS.homedir()],
      ["   ", NodeOS.homedir()],
      ["~/Development", path.join(NodeOS.homedir(), "Development")],
      ["  /configured/code  ", "/configured/code"],
    ]) {
      const destination = yield* managedCloneDestination(base!, "repo").pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            makeDirectory: () => Effect.void,
            realPath: (directory) => Effect.succeed(directory),
            exists: () => Effect.succeed(false),
          }),
        ),
      );
      expect(destination).toBe(path.join(expected!, "repo"));
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("does not let another installation cancel a clone", async () => {
  const { provider } = fixture();
  const result = await provider.invoke(
    "start",
    { title: "Repo", remoteUrl: "git@github.com:alex/repo.git", destinationName: "repo" },
    context,
    signal,
    metadata(provider),
  );
  await expect(
    provider.invoke(
      "cancel",
      { projectId: (result as { projectId: string }).projectId },
      context,
      signal,
      metadata(provider, "other"),
    ),
  ).rejects.toThrow();
  await expect(
    provider.invoke(
      "retry",
      { projectId: ProjectId.make("unowned") },
      context,
      signal,
      metadata(provider),
    ),
  ).rejects.toThrow();
});

it("rejects foreign environments and missing root operate authority", async () => {
  const { provider, calls } = fixture();
  const input = {
    title: "Repo",
    remoteUrl: "https://github.com/alex/repo.git",
    destinationName: "repo",
  };
  await expect(
    provider.invoke(
      "start",
      input,
      { ...context, resource: { ...context.resource, environmentId: "other" } },
      signal,
      metadata(provider),
    ),
  ).rejects.toThrow();
  await expect(
    provider.invoke("start", input, context, signal, {
      ...metadata(provider),
      principal: { ...metadata(provider).principal, scopes: [AuthOrchestrationReadScope] },
    }),
  ).rejects.toThrow();
  expect(calls).toEqual([]);
});

it.effect("refuses existing destination symlinks under the managed root", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const outside = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.symlink(outside, path.join(root, "repo"));
      const result = yield* managedCloneDestination(root, "repo").pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(yield* managedCloneDestination(root, "safe-repo")).toBe(
        path.join(yield* fileSystem.realPath(root), "safe-repo"),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
