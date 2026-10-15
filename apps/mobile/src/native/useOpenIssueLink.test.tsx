// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  RepositoryIdentity,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  EnvironmentRegistry as Registry,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import * as RpcClient from "../../../../packages/client-runtime/src/rpc/client";

const harness = vi.hoisted(() => ({
  route: { params: {} as Record<string, string> },
  configs: new Map<string, unknown>(),
  projects: [] as unknown[],
  issues: [] as unknown[],
  external: [] as string[],
  connected: true,
}));

vi.mock("react-native", () => ({ Keyboard: { dismiss: vi.fn() }, Platform: { OS: "ios" } }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: {},
  StackActions: {},
  useNavigation: () => ({
    navigate: (name: string, params: unknown) => {
      if (name === "Issue") harness.issues.push(params);
    },
  }),
  useRoute: () => harness.route,
}));
vi.mock("../features/workspace/useAndroidWorkspaceSelection", () => ({
  useAndroidWorkspaceSelection: () => vi.fn(),
}));
vi.mock("../lib/openExternalUrl", () => ({
  tryOpenExternalUrl: async (url: string) => {
    harness.external.push(url);
    return true;
  },
}));
vi.mock("../state/entities", () => ({
  useProjects: () => harness.projects,
  useServerConfigs: () => harness.configs,
  useThreadShell: () => ({ projectId: "thread-project" }),
}));
const sessions = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("../../../../packages/client-runtime/src/state/session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const family = Atom.family((_id: string) =>
    Atom.make<AsyncResult.AsyncResult<unknown, never>>(AsyncResult.initial()),
  );
  sessions.atom = family;
  return { createEnvironmentSessionAtoms: () => ({ sessionStateAtom: family }) };
});
vi.mock("../state/issues", async () => {
  const { AVAILABLE_CONNECTION_STATE, EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  const { createIssueEnvironmentAtoms } = await import("@t3tools/client-runtime/state/issues");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { Atom } = await import("effect/reactivity");
  const environments = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
      });
      return EnvironmentRegistry.EnvironmentRegistry.of({
        run: <A, E, R>(environmentId: string, effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const session = harness.connected ? Option.some({}) : Option.none();
            const supervisor = {
              state,
              session: yield* SubscriptionRef.make(session),
              target: { environmentId, label: environmentId },
            } as unknown as Supervisor.EnvironmentSupervisor["Service"];
            return yield* Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor,
            );
          }),
      } as unknown as Registry.EnvironmentRegistry["Service"]);
    }),
  );
  return { issueEnvironment: createIssueEnvironmentAtoms(Atom.runtime(environments)) };
});

import { githubMarkdownLinks } from "@t3tools/shared/githubMarkdownLinks";
import { useOpenIssueLink } from "./useOpenIssueLink";

const decodeRepositoryIdentity = Schema.decodeSync(RepositoryIdentity);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (granted: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: granted ? [AuthOrchestrationReadScope] : [],
  permissions: granted ? [AuthOrchestrationReadScope] : [],
});

const resolved = {
  projectId: "server-project",
  tracker: "linear",
  host: "linear.app",
  scope: "eng",
  key: "ENG-7",
  writable: false,
};

const project = (
  environmentId: string,
  provider: string,
  canonicalKey: string,
  remoteUrl?: string,
) => ({
  environmentId,
  id: `${provider}-project`,
  repositoryIdentity: {
    provider,
    canonicalKey,
    ...(remoteUrl ? { locator: { remoteUrl } } : {}),
  },
});

let calls: Array<{ environmentId: unknown; input: unknown }> = [];
let answer: () => Effect.Effect<unknown, unknown> = () => Effect.succeed(resolved);
const request = vi.spyOn(RpcClient, "requestGuarded");
request.mockImplementation(((tag: string, input: unknown) =>
  Effect.gen(function* () {
    const supervisor = yield* (yield* Effect.promise(
      () => import("@t3tools/client-runtime/connection"),
    )).EnvironmentSupervisor.EnvironmentSupervisor;
    if (tag !== WS_METHODS.issuesResolveUrl) return yield* Effect.die(`unexpected ${tag}`);
    if (!harness.connected) return yield* Effect.fail(new Error("not connected"));
    calls.push({ environmentId: supervisor.target.environmentId, input });
    return yield* answer();
  })) as unknown as Parameters<typeof request.mockImplementation>[0]);

beforeEach(() => {
  calls = [];
  answer = () => Effect.succeed(resolved);
  harness.issues = [];
  harness.external = [];
  harness.connected = true;
  harness.route = { params: { environmentId: "thread-env", threadId: "thread" } };
  harness.projects = [
    project("thread-env", "github", "code.acme.internal/acme/app"),
    project(
      "thread-env",
      "forgejo",
      "git.acme.internal/acme/app",
      "https://git.acme.internal/acme/app.git",
    ),
    project("panel-env", "github", "code.panel.internal/acme/app"),
  ];
  harness.configs = new Map([
    ["thread-env", { environment: { capabilities: { issues: true } } }],
    ["panel-env", { environment: { capabilities: { issues: true } } }],
  ]);
});

async function open(
  url: string,
  options: { granted?: boolean; context?: { environmentId: string; projectId: string } } = {},
) {
  const registry = AtomRegistry.make();
  const sessionAtom = sessions.atom as (id: string) => Atom.Writable<unknown>;
  for (const id of ["thread-env", "panel-env"]) {
    registry.mount(sessionAtom(id));
    registry.set(sessionAtom(id), AsyncResult.success(session(options.granted ?? true)));
  }
  const held: { openLink?: (url: string) => Promise<boolean> } = {};
  function Probe() {
    const openLink = useOpenIssueLink(options.context ? { context: options.context } : undefined);
    useEffect(() => {
      held.openLink = openLink;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
  let opened: boolean | undefined;
  await act(async () => {
    opened = await held.openLink!(url);
  });
  await act(() => root.unmount());
  registry.dispose();
  return opened;
}

it.each([
  "https://github.com/acme/app/issues/7",
  "https://gitlab.com/acme/app/-/issues/7",
  "https://codeberg.org/acme/app/issues/7",
  "https://dev.azure.com/acme/app/_workitems/edit/7",
  "https://linear.app/acme/issue/ENG-7",
  "https://acme.atlassian.net/browse/OPS-7",
  "https://code.acme.internal/acme/app/issues/7",
  "https://git.acme.internal/acme/app/issues/7",
])("opens the issue the thread's server resolves for %s", async (url) => {
  expect(await open(url)).toBe(true);
  expect(calls).toEqual([
    {
      environmentId: EnvironmentId.make("thread-env"),
      input: { url, projectId: "thread-project" },
    },
  ]);
  expect(harness.issues).toEqual([
    {
      environmentId: "thread-env",
      projectId: "server-project",
      tracker: "linear",
      host: "linear.app",
      scope: "eng",
      key: "ENG-7",
      originalURL: url,
    },
  ]);
  expect(harness.external).toEqual([]);
});

it("carries a PR body's generated #N link to the issue route as its original URL", async () => {
  const href = /\]\(([^)]+)\)/u.exec(
    githubMarkdownLinks("Stacked on #456", "https://github.com/acme/app/pull/1"),
  )![1]!;
  expect(await open(href)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(harness.issues).toMatchObject([{ originalURL: "https://github.com/acme/app/issues/456" }]);
  expect(harness.external).toEqual([]);
});

it.each(["team/repo", "Root/Mount/Team/Repo"])(
  "opens an SSH Forgejo checkout's issue at its resolved web authority (%s)",
  async (scope) => {
    const webUrl = `https://git.acme.test:8443/${scope}`;
    harness.projects = [
      {
        environmentId: "thread-env",
        id: "forgejo-project",
        repositoryIdentity: decodeRepositoryIdentity({
          canonicalKey: "ssh.acme.test/team/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@ssh.acme.test:team/repo.git",
          },
          webUrl,
          provider: "forgejo",
        }),
      },
    ];
    const url = `${webUrl}/issues/42`;
    expect(await open(url)).toBe(true);
    expect(calls).toEqual([
      {
        environmentId: EnvironmentId.make("thread-env"),
        input: { url, projectId: "thread-project" },
      },
    ]);
    expect(harness.issues).toMatchObject([{ projectId: "server-project", originalURL: url }]);
    calls = [];
    for (const outside of [
      "https://git.acme.test:9443/team/repo/issues/42",
      "https://unrelated.internal/team/repo/issues/42",
      `${webUrl}/docs/42`,
    ]) {
      await open(outside);
    }
    await open(url, { context: { environmentId: "panel-env", projectId: "panel-project" } });
    expect(calls).toEqual([]);
  },
);

it.each(["not a URL", "ssh://ssh.acme.test/team/repo"])(
  "keeps the remote's HTTPS authority when the resolved web URL is unusable (%s)",
  async (webUrl) => {
    harness.projects = [
      {
        environmentId: "thread-env",
        id: "forgejo-project",
        repositoryIdentity: {
          provider: "forgejo",
          canonicalKey: "git.acme.test/team/repo",
          locator: { remoteUrl: "https://git.acme.test:8443/team/repo.git" },
          webUrl,
        },
      },
    ];
    expect(await open("https://git.acme.test:8443/team/repo/issues/42")).toBe(true);
    expect(calls).toHaveLength(1);
  },
);

it.each(["https://github.com/acme/app/issues/7", "https://code.panel.internal/acme/app/issues/7"])(
  "asks the source panel's environment and project, not the thread's, for %s",
  async (url) => {
    await open(url, { context: { environmentId: "panel-env", projectId: "panel-project" } });
    expect(calls).toEqual([
      {
        environmentId: EnvironmentId.make("panel-env"),
        input: { url, projectId: "panel-project" },
      },
    ]);
    expect(harness.issues).toMatchObject([{ environmentId: "panel-env" }]);
  },
);

it.each([
  "https://example.com/acme/app/issues/7",
  "https://evilgithub.com/acme/app/issues/7",
  "https://unknown.internal/acme/app/issues/7",
  "https://code.panel.internal/acme/app/issues/7",
  "https://linear.app.evil.example/acme/issue/ENG-7",
  "https://acme.atlassian.net.evil.example/browse/OPS-7",
  "https://github.com/acme/app",
  "https://github.com/acme/app/pull/7",
])("keeps %s on the existing pull request or browser path without a resolve", async (url) => {
  await open(url);
  expect(calls).toEqual([]);
  expect(harness.issues).toEqual([]);
});

it.each([
  { name: "denied", granted: false, change: () => {} },
  {
    name: "older server",
    granted: true,
    change: () => harness.configs.set("thread-env", { environment: { capabilities: {} } }),
  },
  {
    name: "unknown method",
    granted: true,
    change: () => {
      answer = () => Effect.fail(new Error("Unknown method issues.resolveUrl"));
    },
  },
  {
    name: "bound to no project",
    granted: true,
    change: () => {
      answer = () => Effect.fail(new Error("tracker-unsupported"));
    },
  },
  {
    name: "offline",
    granted: true,
    change: () => {
      harness.connected = false;
    },
  },
])("falls back to the browser when the resolver is $name", async ({ granted, change }) => {
  change();
  const url = "https://github.com.evil.example/acme/app/issues/7";
  expect(await open(url, { granted })).toBe(true);
  expect(harness.issues).toEqual([]);
  expect(harness.external).toEqual([url]);
});
