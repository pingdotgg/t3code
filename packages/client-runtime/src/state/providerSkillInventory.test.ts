import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ProviderSkillInventoryTarget,
  resolveProviderSkillInventoryRequest,
  resolveProviderSkillInventoryTarget,
  selectProviderSkills,
} from "./providerSkillInventory.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const FALLBACK_ENVIRONMENT_ID = EnvironmentId.make("env-fallback");
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const INSTANCE_ID = ProviderInstanceId.make("cursor-default");

const skill = (name: string): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
});

const provider = (input: {
  readonly mode?: "project";
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}): ServerProvider =>
  ({
    instanceId: INSTANCE_ID,
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: input.skills ?? [],
    ...(input.mode ? { skillInventoryMode: input.mode } : {}),
  }) as ServerProvider;

const target = (
  overrides?: Partial<Parameters<typeof resolveProviderSkillInventoryRequest>[0]>,
): ProviderSkillInventoryTarget => ({
  environmentId: ENVIRONMENT_ID,
  provider: provider({ mode: "project" }),
  scope: { kind: "thread", threadId: THREAD_ID },
  ...overrides,
});

describe("resolveProviderSkillInventoryTarget", () => {
  it("uses the active thread environment and thread scope for a server thread", () => {
    expect(
      resolveProviderSkillInventoryTarget({
        activeEnvironmentId: ENVIRONMENT_ID,
        fallbackEnvironmentId: FALLBACK_ENVIRONMENT_ID,
        provider: provider({ mode: "project" }),
        isServerThread: true,
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
      }),
    ).toEqual({
      environmentId: ENVIRONMENT_ID,
      provider: provider({ mode: "project" }),
      scope: { kind: "thread", threadId: THREAD_ID },
    });
  });

  it("uses fallback environment and project scope for a local draft with a preallocated id", () => {
    expect(
      resolveProviderSkillInventoryTarget({
        activeEnvironmentId: null,
        fallbackEnvironmentId: FALLBACK_ENVIRONMENT_ID,
        provider: provider({ mode: "project" }),
        isServerThread: false,
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
      }),
    ).toEqual({
      environmentId: FALLBACK_ENVIRONMENT_ID,
      provider: provider({ mode: "project" }),
      scope: { kind: "project", projectId: PROJECT_ID },
    });
  });

  it("leaves scope unresolved when neither a durable thread nor project exists", () => {
    expect(
      resolveProviderSkillInventoryTarget({
        activeEnvironmentId: null,
        provider: null,
        isServerThread: false,
        threadId: THREAD_ID,
        projectId: null,
      }),
    ).toEqual({ environmentId: null, provider: null, scope: null });
  });
});

describe("resolveProviderSkillInventoryRequest", () => {
  it("requests thread scope when composing inside a thread", () => {
    expect(resolveProviderSkillInventoryRequest(target())).toEqual({
      environmentId: ENVIRONMENT_ID,
      input: { scope: { kind: "thread", threadId: THREAD_ID }, instanceId: INSTANCE_ID },
    });
  });

  it("requests project scope for a new-task draft with no thread yet", () => {
    expect(
      resolveProviderSkillInventoryRequest(
        target({ scope: { kind: "project", projectId: PROJECT_ID } }),
      ),
    ).toEqual({
      environmentId: ENVIRONMENT_ID,
      input: { scope: { kind: "project", projectId: PROJECT_ID }, instanceId: INSTANCE_ID },
    });
  });

  it("issues no request for a snapshot-mode provider", () => {
    expect(resolveProviderSkillInventoryRequest(target({ provider: provider({}) }))).toBeNull();
  });

  it("issues no request when the scope, environment, or provider is unknown", () => {
    expect(resolveProviderSkillInventoryRequest(target({ scope: null }))).toBeNull();
    expect(resolveProviderSkillInventoryRequest(target({ environmentId: null }))).toBeNull();
    expect(resolveProviderSkillInventoryRequest(target({ provider: null }))).toBeNull();
  });

  /**
   * The key is what the query layer dedupes and caches on, so it must be
   * identical across consumers of the same scope and different across scopes.
   */
  it("keys by environment, scope, and instance only", () => {
    const first = resolveProviderSkillInventoryRequest(target());
    const sameScope = resolveProviderSkillInventoryRequest(target());
    expect(sameScope).toEqual(first);

    const otherThread = resolveProviderSkillInventoryRequest(
      target({ scope: { kind: "thread", threadId: ThreadId.make("thread-2") } }),
    );
    expect(otherThread).not.toEqual(first);

    const otherInstance = resolveProviderSkillInventoryRequest(
      target({
        provider: {
          ...provider({ mode: "project" }),
          instanceId: ProviderInstanceId.make("cursor-second"),
        },
      }),
    );
    expect(otherInstance).not.toEqual(first);
  });
});

describe("selectProviderSkills", () => {
  it("uses snapshot skills for a snapshot-mode provider even if inventory exists", () => {
    expect(
      selectProviderSkills({
        provider: provider({ skills: [skill("from-snapshot")] }),
        inventory: { skills: [skill("from-rpc")] },
      }).map((entry) => entry.name),
    ).toEqual(["from-snapshot"]);
  });

  it("uses the fetched inventory for a project-mode provider", () => {
    expect(
      selectProviderSkills({
        provider: provider({ mode: "project", skills: [skill("from-snapshot")] }),
        inventory: { skills: [skill("from-rpc")] },
      }).map((entry) => entry.name),
    ).toEqual(["from-rpc"]);
  });

  it("falls back to snapshot skills before the first response and after a failure", () => {
    expect(
      selectProviderSkills({
        provider: provider({ mode: "project", skills: [skill("from-snapshot")] }),
        inventory: null,
      }).map((entry) => entry.name),
    ).toEqual(["from-snapshot"]);
  });

  it("renders an empty picker when no provider is selected", () => {
    expect(selectProviderSkills({ provider: null, inventory: { skills: [skill("x")] } })).toEqual(
      [],
    );
  });
});
