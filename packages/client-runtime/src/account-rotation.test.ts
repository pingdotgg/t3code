import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseRotatedProviderInstance,
  rotatesAccountsForProject,
  rotationEligibleInstanceIds,
} from "./account-rotation.ts";

const environmentId = EnvironmentId.make("mac");
const work = ProviderInstanceId.make("claudeAgent");
const personal = ProviderInstanceId.make("claudeAgent_personal");
const spare = ProviderInstanceId.make("claudeAgent_spare");
const model = "claude-opus-5-5";

function window(usedPercent: number, resetsAt = "2026-09-03T14:00:00.000Z") {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    resetsAt,
  } satisfies ServerProviderUsageWindow;
}

function account(
  instanceId: ProviderInstanceId,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [{ slug: model, name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
    ...overrides,
  };
}

/** Every account is marked for rotation unless a case names the marked ones. */
function choose(
  providers: ReadonlyArray<ServerProvider>,
  threads: Parameters<typeof chooseRotatedProviderInstance>[0]["threads"] = [],
  selected = work,
  marked: ReadonlyArray<ProviderInstanceId> = providers.map((provider) => provider.instanceId),
) {
  return chooseRotatedProviderInstance({
    selection: { instanceId: selected, model },
    environmentId,
    providers,
    eligibleInstanceIds: new Set(marked),
    threads,
  });
}

const startedAt = (providerInstanceId: ProviderInstanceId, createdAt: string) => ({
  environmentId,
  providerInstanceId,
  createdAt,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make(`thread-${createdAt}`),
  },
});

describe("rotating a new thread across accounts of one provider", () => {
  it("starts on the account with the most usage left", () => {
    expect(choose([account(work, [window(90)]), account(personal, [window(15)])])).toBe(personal);
  });

  it.each(["claudeAgent", "codex", "cursor"])("treats %s accounts alike", (driver) => {
    const first = ProviderInstanceId.make(driver);
    const second = ProviderInstanceId.make(`${driver}_personal`);
    const of = { driver: ProviderDriverKind.make(driver) };
    const providers = [account(first, [window(90)], of), account(second, [window(15)], of)];
    expect(choose(providers, [], first)).toBe(second);
    expect(choose(providers, [], second)).toBe(second);
  });

  it("judges an account by its fullest window", () => {
    const weekly = { ...window(95), id: "seven_day", kind: "weekly" as const, label: "Weekly" };
    expect(choose([account(work, [window(40)]), account(personal, [window(5), weekly])])).toBe(
      work,
    );
  });

  it("stops counting a window that reset before the environment's latest report", () => {
    const stale = account(personal, [window(100, "2026-09-03T11:30:00.000Z")]);
    expect(choose([account(work, [window(40)]), stale])).toBe(work);
    expect(
      choose([account(work, [window(40)], { checkedAt: "2026-09-03T12:00:00.000Z" }), stale]),
    ).toBe(personal);
  });

  it("takes turns when accounts report the same usage or none", () => {
    const providers = [account(work, []), account(personal, []), account(spare, [])];
    expect(choose(providers)).toBe(work);
    const first = [startedAt(work, "2026-09-03T09:00:00.000Z")];
    expect(choose(providers, first)).toBe(personal);
    const second = [...first, startedAt(personal, "2026-09-03T10:00:00.000Z")];
    expect(choose(providers, second)).toBe(spare);
    const third = [...second, startedAt(spare, "2026-09-03T11:00:00.000Z")];
    expect(choose(providers, third)).toBe(work);
  });

  it("takes turns when a marked account reports no usage, since silence is not room left", () => {
    const providers = [
      account(work, [window(40)]),
      account(personal, [window(5)]),
      account(spare, [], {
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported" },
        },
      }),
    ];
    expect(choose(providers)).toBe(work);
    const first = [startedAt(work, "2026-09-03T09:00:00.000Z")];
    expect(choose(providers, first)).toBe(personal);
    const second = [...first, startedAt(personal, "2026-09-03T10:00:00.000Z")];
    expect(choose(providers, second)).toBe(spare);
    const third = [...second, startedAt(spare, "2026-09-03T11:00:00.000Z")];
    expect(choose(providers, third)).toBe(work);
    // An unmarked silent account does not stop the others ranking by usage.
    expect(choose(providers, third, work, [work, personal])).toBe(personal);
  });

  it("gives a subagent thread no turn of its own", () => {
    const providers = [account(work, []), account(personal, [])];
    const spawned = startedAt(personal, "2026-09-03T10:00:00.000Z");
    expect(
      choose(providers, [
        startedAt(work, "2026-09-03T09:00:00.000Z"),
        {
          ...spawned,
          lineage: {
            ...spawned.lineage,
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent" as const,
          },
        },
      ]),
    ).toBe(personal);
  });

  it("ignores threads on another environment's account of the same name", () => {
    const providers = [account(work, []), account(personal, [])];
    expect(
      choose(providers, [
        startedAt(work, "2026-09-03T09:00:00.000Z"),
        {
          ...startedAt(personal, "2026-09-03T10:00:00.000Z"),
          environmentId: EnvironmentId.make("vps"),
        },
      ]),
    ).toBe(personal);
  });

  it("skips accounts that cannot run the selected model right now", () => {
    const idle = [window(0)];
    expect(
      choose([
        account(work, [window(80)]),
        account(personal, idle, { enabled: false }),
        account(spare, idle, { auth: { status: "unauthenticated" } }),
        account(ProviderInstanceId.make("claudeAgent_unknown"), idle, {
          auth: { status: "unknown" },
        }),
        account(ProviderInstanceId.make("claudeAgent_broken"), idle, { status: "error" }),
        account(ProviderInstanceId.make("claudeAgent_gone"), idle, {
          availability: "unavailable",
        }),
        account(ProviderInstanceId.make("claudeAgent_sonnet"), idle, {
          models: [
            { slug: "claude-sonnet-5-5", name: "Sonnet", isCustom: false, capabilities: null },
          ],
        }),
        account(ProviderInstanceId.make("codex"), idle, {
          driver: ProviderDriverKind.make("codex"),
        }),
      ]),
    ).toBe(work);
  });

  it.each<[string, Partial<ServerProvider>]>([
    ["signed out", { auth: { status: "unauthenticated" } }],
    ["failing", { status: "error" }],
    ["missing the model", { models: [] }],
  ])("leaves a selected account that is %s for one that can start the thread", (_, broken) => {
    expect(choose([account(work, [window(0)], broken), account(personal, [window(60)])])).toBe(
      personal,
    );
    // With nowhere better to go, the selection stands and the composer reports it.
    expect(
      choose([account(work, [window(0)], broken), account(personal, [window(0)], broken)]),
    ).toBe(work);
  });

  it("only chooses among the accounts marked for rotation", () => {
    const providers = [
      account(work, [window(90)]),
      account(personal, [window(5)]),
      account(spare, [window(40)]),
    ];
    expect(choose(providers, [], work, [work, spare])).toBe(spare);
  });

  it("leaves a selection that is not marked for rotation where it is", () => {
    const providers = [account(work, [window(90)]), account(personal, [window(5)])];
    expect(choose(providers, [], work, [personal])).toBe(work);
    expect(choose(providers, [], work, [])).toBe(work);
  });

  it("rotates any marked account, whatever it reports about its usage", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    const { usageLimits: _none, ...silent } = account(spare, []);
    const providers = [
      account(work, [], {
        usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      }),
      account(personal, [], {
        usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
      }),
      silent,
    ];
    const first = [startedAt(work, "2026-09-03T09:00:00.000Z")];
    expect(choose(providers, first)).toBe(personal);
    expect(choose(providers, [...first, startedAt(personal, "2026-09-03T10:00:00.000Z")])).toBe(
      spare,
    );
  });

  it("keeps the selection when it is not a configured account", () => {
    expect(choose([account(personal, [window(0)])])).toBe(work);
  });
});

describe("which projects rotate accounts", () => {
  const projectId = ProjectId.make("project");
  const pinned = { instanceId: work, model };

  it("follows the environment setting, including with an environment default model", () => {
    expect(rotatesAccountsForProject(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null))).toBe(
      false,
    );
    expect(
      rotatesAccountsForProject(
        resolveProjectSettings(
          {
            ...DEFAULT_SERVER_SETTINGS,
            rotateProviderAccounts: true,
            defaultModelSelection: pinned,
          },
          projectId,
        ),
      ),
    ).toBe(true);
  });

  it("leaves a project with its own default model on that account", () => {
    expect(
      rotatesAccountsForProject(
        resolveProjectSettings(
          {
            ...DEFAULT_SERVER_SETTINGS,
            rotateProviderAccounts: true,
            projectSettingsOverrides: { [projectId]: { defaultModelSelection: pinned } },
          },
          projectId,
        ),
      ),
    ).toBe(false);
  });
});

describe("which accounts are marked for rotation", () => {
  it("takes only the instances the user marked", () => {
    expect([
      ...rotationEligibleInstanceIds({
        [work]: { rotate: true },
        [personal]: {},
        [spare]: { rotate: false },
      }),
    ]).toEqual([work]);
  });
});

describe("the rotation choice is stable for any small pool", () => {
  type Usage = "none" | "idle" | "half" | "halfReset";
  type Started = "never" | "early" | "late";
  interface Spec {
    readonly marked: boolean;
    readonly usage: Usage;
    readonly started: Started;
    readonly canStart: boolean;
  }
  const usages: ReadonlyArray<Usage> = ["none", "idle", "half", "halfReset"];
  const startedLevels: ReadonlyArray<Started> = ["never", "early", "late"];
  const specs: ReadonlyArray<Spec> = [];
  for (const marked of [true, false])
    for (const usage of usages)
      for (const started of startedLevels)
        for (const canStart of [true, false])
          (specs as Spec[]).push({ marked, usage, started, canStart });

  const ids = [work, personal, spare];
  const startTime = { early: "2026-09-03T09:00:00.000Z", late: "2026-09-03T10:00:00.000Z" };
  // checkedAt is 11:00, so a window resetting at 10:30 has already reset.
  const windowsOf = (usage: Usage) =>
    usage === "none"
      ? []
      : usage === "idle"
        ? [window(0)]
        : usage === "half"
          ? [window(50)]
          : [window(100, "2026-09-03T10:30:00.000Z")];

  /** The requirement, written from the spec rather than from the implementation. */
  function expected(selectedIndex: number, pool: ReadonlyArray<Spec>) {
    const selected = pool[selectedIndex]!;
    if (!selected.marked) return new Set([ids[selectedIndex]!]);
    const members = pool
      .map((spec, index) => ({ spec, index }))
      .filter(({ spec, index }) => spec.canStart && (index === selectedIndex || spec.marked));
    if (members.length === 0) return new Set([ids[selectedIndex]!]);
    const ranked = members.every(({ spec }) => spec.usage !== "none");
    const used = (spec: Spec) =>
      spec.usage === "half" ? 50 : 0; /* none, idle and an already-reset window hold nothing */
    const rank = ({ spec }: { spec: Spec }) =>
      [
        ranked ? used(spec) : 0,
        spec.started === "never" ? 0 : spec.started === "early" ? 1 : 2,
      ] as const;
    const best = members.reduce((a, b) => {
      const [au, as] = rank(a);
      const [bu, bs] = rank(b);
      return bu < au || (bu === au && bs < as) ? b : a;
    });
    const [bestUsed, bestStart] = rank(best);
    return new Set(
      members
        .filter(({ spec }) => {
          const [u, s] = rank({ spec });
          return u === bestUsed && s === bestStart;
        })
        .map(({ index }) => ids[index]!),
    );
  }

  function run(pool: ReadonlyArray<Spec>, selectedIndex: number) {
    const providers = pool.map((spec, index) =>
      account(ids[index]!, windowsOf(spec.usage), spec.canStart ? {} : { status: "error" }),
    );
    const threads = pool.flatMap((spec, index) =>
      spec.started === "never" ? [] : [startedAt(ids[index]!, startTime[spec.started])],
    );
    const marked = ids.filter((_, index) => pool[index]!.marked);
    const pick = (from: ProviderInstanceId) =>
      chooseRotatedProviderInstance({
        selection: { instanceId: from, model },
        environmentId,
        providers,
        eligibleInstanceIds: new Set(marked),
        threads,
      });
    return { first: pick(ids[selectedIndex]!), pick };
  }

  it("answers with a best account and answers the same when asked from its own answer", () => {
    let cases = 0;
    for (const a of specs)
      for (const b of specs)
        for (const c of specs) {
          const pool = [a, b, c];
          for (let selectedIndex = 0; selectedIndex < 3; selectedIndex++) {
            const { first, pick } = run(pool, selectedIndex);
            const context = JSON.stringify({ pool, selectedIndex, first });
            expect(expected(selectedIndex, pool).has(first), `not a best account ${context}`).toBe(
              true,
            );
            expect(pick(first), `unstable ${context}`).toBe(first);
            cases++;
          }
        }
    expect(cases).toBe(specs.length ** 3 * 3);
  });
});
