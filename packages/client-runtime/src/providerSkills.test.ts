import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createProviderWorkspaceSnapshotRefreshAtomFamily,
  getProviderSkillsForSlashMenu,
  hasCompleteProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "./providerSkills.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "global" }],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace/project-a",
      checkedAt: "2026-01-01T00:01:00.000Z",
      slashCommands: [{ name: "project" }],
      skills: [{ name: "project", path: "/workspace/project-a/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("shows one row when enabled skills share a name", () => {
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
      {
        name: "browser",
        path: "/Users/matt/.agents/skills/browser/SKILL.md",
        enabled: true,
      },
      {
        name: "babysit-pr",
        path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "babysit-pr",
      "browser",
    ]);
  });

  it("keeps an enabled skill when a disabled duplicate appears first", () => {
    const enabledSkill = {
      name: "babysit-pr",
      path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
      enabled: true,
    };
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: false,
      },
      enabledSkill,
    ];

    expect(getProviderSkillsForSlashMenu(skills, true)).toEqual([enabledSkill]);
  });
});

describe("workspace provider snapshots", () => {
  it("uses the cwd snapshot after a provider session has populated it", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project", path: "/workspace/project-a/SKILL.md", enabled: true },
    ]);
    expect(resolveProviderSlashCommandsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project" },
    ]);
  });

  it("keeps the machine snapshot before this cwd has a provider snapshot", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-b")).toEqual(provider.skills);
    expect(resolveProviderSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands);
  });

  it("uses partial workspace skills and commands while keeping discovery retryable", () => {
    const partial = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommands: [{ name: "compact" }],
        slashCommandsPending: true,
      })),
    } satisfies ServerProvider;
    expect(resolveProviderSkillsForCwd(partial, "/workspace/project-a")).toEqual(
      provider.workspaceSnapshots[0]?.skills,
    );
    expect(resolveProviderSlashCommandsForCwd(partial, "/workspace/project-a")).toEqual([
      { name: "compact" },
    ]);
    expect(hasCompleteProviderWorkspaceSnapshot(partial, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-a")).toBe(true);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-b")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(undefined, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, null)).toBe(false);
  });
});

describe("provider workspace snapshot refresh atom", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const cwd = "/workspace/project-a";
  const environmentId = EnvironmentId.make("env");
  const withSnapshot = (
    checkedAt: string,
    slashCommandsPending?: boolean,
  ): ReadonlyArray<ServerProvider> => [
    {
      ...provider,
      workspaceSnapshots: [
        {
          ...provider.workspaceSnapshots[0]!,
          checkedAt,
          ...(slashCommandsPending ? { slashCommandsPending } : {}),
        },
      ],
    },
  ];
  const noSnapshot: ReadonlyArray<ServerProvider> = [{ ...provider, workspaceSnapshots: [] }];

  type Response = () =>
    | ReadonlyArray<ServerProvider>
    | null
    | Promise<ReadonlyArray<ServerProvider> | null>;

  function setup(initialProviders: ReadonlyArray<ServerProvider>, initialResponses?: Response[]) {
    const providersAtom = Atom.make<ReadonlyArray<ServerProvider> | null>(initialProviders);
    const responses: Response[] = [...(initialResponses ?? [])];
    const run = vi.fn(async () => {
      const providers = await (responses.shift() ?? (() => null))();
      return providers === null
        ? AsyncResult.failure<{ providers: ReadonlyArray<ServerProvider> }, string>(
            Cause.fail("offline"),
          )
        : AsyncResult.success({ providers });
    });
    const family = createProviderWorkspaceSnapshotRefreshAtomFamily({
      providers: () => providersAtom,
      refreshProviders: { label: "refresh", run },
    });
    const registry = AtomRegistry.make();
    const atom = family({ environmentId, instanceId: provider.instanceId, cwd });
    const unmount = registry.mount(atom);
    return { registry, atom, family, providersAtom, responses, run, unmount };
  }

  it("scans a missing snapshot once and skips a repeat inside the TTL", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, family, responses, run, unmount } = setup(noSnapshot);
    // A second composer on the same target shares the scan.
    registry.mount(family({ environmentId, instanceId: provider.instanceId, cwd }))();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), {
      environmentId,
      input: { instanceId: provider.instanceId, cwd },
    });
    responses.push(() => withSnapshot("2026-01-01T00:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(0);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each(["already expired", "expires during discovery"])(
    "retries an unchanged catalog that %s after the short cooldown",
    async (expiry) => {
      const start = Date.parse("2026-01-01T00:05:00.000Z");
      vi.useFakeTimers({ now: expiry === "expires during discovery" ? start - 1 : start });
      const stale = withSnapshot("2026-01-01T00:00:00.000Z");
      const { registry, atom, responses, run, unmount } = setup(
        expiry === "expires during discovery"
          ? withSnapshot("2026-01-01T00:00:00.000Z", true)
          : stale,
        [
          () => {
            if (expiry === "expires during discovery") vi.setSystemTime(start + 1);
            return stale;
          },
        ],
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(9_999);
      registry.refresh(atom);
      expect(run).toHaveBeenCalledTimes(1);
      responses.push(() => withSnapshot("2026-01-01T00:05:10.000Z"));
      await vi.advanceTimersByTimeAsync(1);
      registry.refresh(atom);
      expect(run).toHaveBeenCalledTimes(2);
      unmount();
    },
  );

  it("keeps the TTL guard for a newly scanned catalog when the client clock is ahead", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T01:00:00.000Z") });
    const { registry, atom, run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z"), [
      () => withSnapshot("2026-01-01T00:01:00.000Z"),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("bounds retries when discovery repeatedly returns the same expired catalog", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:05:00.000Z") });
    const stale = withSnapshot("2026-01-01T00:00:00.000Z");
    const { registry, atom, run, unmount } = setup(stale, [() => stale, () => stale, () => stale]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    registry.refresh(atom);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    registry.refresh(atom);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("does not rescan a current snapshot, and rescans once it ages past the TTL", () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:01:00.000Z") });
    const { registry, atom, run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z"));
    expect(run).not.toHaveBeenCalled();
    vi.setSystemTime(Date.parse("2026-01-01T00:05:00.000Z"));
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("cools down a failed scan, then retries on its own while the scan stays pending", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z", true));
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying after three failed scans until the TTL lapses", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z", true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(3);
    registry.refresh(atom);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(Date.parse("2026-01-01T00:10:00.000Z"));
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(4);
    unmount();
  });

  it("does not retry on a timer when the failed scan left no pending snapshot", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, atom, run, unmount } = setup(noSnapshot);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    registry.refresh(atom);
    expect(run).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("rescans at once when the server drops the snapshot, lifting TTL and cooldown", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const { registry, providersAtom, run, unmount } = setup(noSnapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    registry.set(providersAtom, withSnapshot("2026-01-01T00:00:00.000Z"));
    expect(run).toHaveBeenCalledTimes(1);
    registry.set(providersAtom, noSnapshot);
    expect(run).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("does not scan again when a scan fails after the last subscriber left", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run, unmount } = setup(withSnapshot("2026-01-01T00:00:00.000Z", true), [
      async () => {
        await gate;
        return null;
      },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores provider updates that leave the snapshot status unchanged", () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:01:00.000Z") });
    const { registry, providersAtom, run, unmount } = setup(
      withSnapshot("2026-01-01T00:00:00.000Z"),
    );
    vi.setSystemTime(Date.parse("2026-01-01T00:06:00.000Z"));
    registry.set(providersAtom, withSnapshot("2026-01-01T00:00:00.000Z"));
    expect(run).not.toHaveBeenCalled();
    unmount();
  });
});
