/**
 * Dev-only stand-ins for `environmentPresentations` that exercise the pooled
 * Limits view's merge rules, one scenario per named fixture. Reached with
 * `/usage?limitsFixture=<name>` on a dev build; never bundled otherwise.
 */
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Presentation {
  readonly entry: { readonly target: { readonly label: string } };
  readonly serverConfig: {
    readonly providers: readonly ServerProvider[];
    readonly usageLimitSources: readonly UsageLimitSourceSnapshot[];
  };
}

type Fixture = ReadonlyMap<EnvironmentId, Presentation>;

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

function makeHelpers(now: number) {
  const at = (ms: number) => new Date(now + ms).toISOString();
  const checked = (agoMs: number) => new Date(now - agoMs).toISOString();

  const session = (used: number, resetsInMs: number): ServerProviderUsageWindow => ({
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: used,
    windowDurationMins: 300,
    resetsAt: at(resetsInMs),
  });
  const weekly = (
    id: string,
    label: string,
    used: number,
    resetsInMs: number,
  ): ServerProviderUsageWindow => ({
    id,
    kind: "weekly",
    label,
    usedPercent: used,
    windowDurationMins: 7 * 24 * 60,
    resetsAt: at(resetsInMs),
  });
  /** Codex names its five-hour window `primary` and its weekly one `secondary`. */
  const codexSession = (used: number, resetsInMs: number): ServerProviderUsageWindow => ({
    ...session(used, resetsInMs),
    id: "primary",
  });
  const codexWeekly = (used: number, resetsInMs: number) =>
    weekly("secondary", "Weekly", used, resetsInMs);

  const provider = (
    overrides: Partial<ServerProvider> & Pick<ServerProvider, "instanceId" | "driver">,
  ): ServerProvider => ({
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: checked(0),
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });

  const codexInstance = (input: {
    readonly instanceId: string;
    readonly displayName?: string;
    readonly accentColor?: string;
    readonly email: string;
    readonly plan?: string;
    readonly checkedAgoMs?: number;
    readonly windows: readonly ServerProviderUsageWindow[];
    readonly credits?: number;
  }) =>
    provider({
      instanceId: ProviderInstanceId.make(input.instanceId),
      driver: codex,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      auth: {
        status: "authenticated",
        label: input.plan ?? "ChatGPT Pro 20x Subscription",
        email: input.email,
      },
      usageLimits: {
        checkedAt: checked(input.checkedAgoMs ?? MINUTE),
        windows: input.windows,
        ...(input.credits
          ? { resetCredits: { availableCount: input.credits, nextExpiresAt: at(28 * DAY) } }
          : {}),
      },
    });

  const claudeHubAccount = (
    email: string | null,
    windows: readonly ServerProviderUsageWindow[],
    checkedAgoMs = 4 * MINUTE,
  ): UsageLimitSourceSnapshot["accounts"][number] => ({
    id: email ? `claude-${email}.json` : "claude-team-seat.json",
    driver: claude,
    ...(email ? { email } : {}),
    plan: "Claude Subscription",
    usageLimits: { checkedAt: checked(checkedAgoMs), windows },
  });

  const hub = (
    id: string,
    label: string,
    accounts: UsageLimitSourceSnapshot["accounts"],
    error?: string,
  ): UsageLimitSourceSnapshot => ({
    id: UsageLimitSourceId.make(id),
    kind: "cliproxy",
    label,
    checkedAt: checked(2 * MINUTE),
    accounts,
    ...(error ? { error } : {}),
  });

  const environment = (
    id: string,
    label: string,
    providers: readonly ServerProvider[],
    usageLimitSources: readonly UsageLimitSourceSnapshot[] = [],
  ): readonly [EnvironmentId, Presentation] => [
    EnvironmentId.make(id),
    { entry: { target: { label } }, serverConfig: { providers, usageLimitSources } },
  ];

  return {
    at,
    checked,
    session,
    weekly,
    codexSession,
    codexWeekly,
    provider,
    codexInstance,
    claudeHubAccount,
    hub,
    environment,
  };
}

const FIXTURES: Record<string, (now: number) => Fixture> = {
  /**
   * The same Codex account signed in on two machines with different snapshot
   * ages, plus a hub that also reports it. Must collapse to one segment with
   * the freshest figures and both machines listed.
   */
  "same-account": (now) => {
    const h = makeHelpers(now);
    const email = "main@example.com";
    const hubAccounts: UsageLimitSourceSnapshot["accounts"] = [
      {
        id: `codex-abc-${email}-pro.json`,
        driver: codex,
        email,
        plan: "ChatGPT Pro 20x Subscription",
        usageLimits: { checkedAt: h.checked(14 * MINUTE), windows: [h.codexWeekly(70, 5 * DAY)] },
      },
    ];
    return new Map([
      h.environment(
        "env-macbook",
        "MacBook Pro",
        [
          h.codexInstance({
            instanceId: "codex",
            displayName: "Codex Personal",
            accentColor: "#6366f1",
            email,
            windows: [h.codexSession(10, 3 * HOUR), h.codexWeekly(66, 5 * DAY)],
            credits: 2,
          }),
        ],
        [h.hub("cliproxy-nucbox", "CLI Proxy", hubAccounts)],
      ),
      h.environment("env-nucbox", "nucbox-1", [
        h.codexInstance({
          instanceId: "codex",
          email,
          checkedAgoMs: 9 * MINUTE,
          windows: [h.codexSession(30, 3 * HOUR), h.codexWeekly(60, 5 * DAY)],
          credits: 2,
        }),
      ]),
    ]);
  },

  /**
   * Three machines, no two alike: one has only Codex, one only Claude via a
   * hub, one has both natively. Filtering to any single environment should
   * drop whole provider sections.
   */
  "uneven-environments": (now) => {
    const h = makeHelpers(now);
    return new Map([
      h.environment("env-macbook", "MacBook Pro", [
        h.codexInstance({
          instanceId: "codex",
          displayName: "Codex Personal",
          accentColor: "#6366f1",
          email: "main@example.com",
          windows: [h.codexSession(10, 3 * HOUR), h.codexWeekly(66, 5 * DAY)],
          credits: 2,
        }),
        h.provider({
          instanceId: ProviderInstanceId.make("claude"),
          driver: claude,
          auth: { status: "authenticated", label: "Claude Max", email: "main@example.com" },
          usageLimits: {
            checkedAt: h.checked(MINUTE),
            windows: [
              h.session(2, 4 * HOUR),
              h.weekly("seven_day", "Weekly", 38, 4 * DAY),
              h.weekly("seven_day_fable", "Weekly · Fable", 69, 4 * DAY),
            ],
          },
        }),
      ]),
      h.environment(
        "env-nucbox",
        "nucbox-1",
        [],
        [
          h.hub("cliproxy-nucbox", "CLI Proxy", [
            h.claudeHubAccount("personal@example.com", [
              h.session(100, 4 * HOUR),
              h.weekly("seven_day", "Weekly", 50, DAY),
              h.weekly("seven_day_fable", "Weekly · Fable", 96, DAY),
            ]),
            h.claudeHubAccount("second@example.org", [
              h.session(63, 2 * HOUR),
              h.weekly("seven_day", "Weekly", 37, 4 * DAY),
              h.weekly("seven_day_fable", "Weekly · Fable", 72, 4 * DAY),
            ]),
          ]),
        ],
      ),
      h.environment("env-macmini", "Mac Mini", [
        h.codexInstance({
          instanceId: "codex",
          displayName: "Codex Work",
          email: "work@example.com",
          windows: [h.codexSession(0, 5 * HOUR), h.codexWeekly(95, 5 * DAY)],
          credits: 1,
        }),
      ]),
    ]);
  },

  /**
   * Codex plans that report only one window (Go reports a monthly allowance;
   * a hub often has no five-hour figure for an account) mixed with a plan that
   * reports both. Each pool lists only the accounts that have that window.
   */
  "codex-window-mix": (now) => {
    const h = makeHelpers(now);
    return new Map([
      h.environment(
        "env-macbook",
        "MacBook Pro",
        [
          h.codexInstance({
            instanceId: "codex",
            displayName: "Codex Personal",
            accentColor: "#6366f1",
            email: "main@example.com",
            windows: [h.codexSession(40, 2 * HOUR), h.codexWeekly(55, 3 * DAY)],
            credits: 2,
          }),
          h.codexInstance({
            instanceId: "codex-go",
            displayName: "Codex Go",
            accentColor: "#10b981",
            email: "go@example.com",
            plan: "ChatGPT Go Subscription",
            windows: [
              {
                id: "primary",
                kind: "monthly",
                label: "Monthly",
                usedPercent: 82,
                windowDurationMins: 30 * 24 * 60,
                resetsAt: h.at(11 * DAY),
              },
            ],
          }),
        ],
        [
          h.hub("cliproxy-nucbox", "CLI Proxy", [
            {
              id: "codex-def-work@example.com-pro.json",
              driver: codex,
              email: "work@example.com",
              plan: "ChatGPT Pro 20x Subscription",
              usageLimits: {
                checkedAt: h.checked(3 * MINUTE),
                windows: [h.codexWeekly(88, 6 * DAY)],
              },
            },
            {
              id: "codex-ghi-team@example.net-plus.json",
              driver: codex,
              email: "team@example.net",
              plan: "ChatGPT Plus Subscription",
              usageLimits: {
                checkedAt: h.checked(3 * MINUTE),
                windows: [h.codexWeekly(12, DAY)],
              },
            },
          ]),
        ],
      ),
    ]);
  },

  /**
   * A hub configured on two environments, a hub that is down, a provider
   * whose probe failed, an API-key account, and a hub account with no email.
   */
  "failures-and-strays": (now) => {
    const h = makeHelpers(now);
    const hubAccounts: UsageLimitSourceSnapshot["accounts"] = [
      h.claudeHubAccount("main@example.com", [
        h.session(2, 4 * HOUR),
        h.weekly("seven_day", "Weekly", 38, 4 * DAY),
        h.weekly("seven_day_fable", "Weekly · Fable", 69, 4 * DAY),
      ]),
      h.claudeHubAccount(null, [
        h.session(40, 2 * HOUR),
        h.weekly("seven_day", "Weekly", 20, 6 * DAY),
      ]),
    ];
    return new Map([
      h.environment(
        "env-macbook",
        "MacBook Pro",
        [
          h.provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: claude,
            auth: { status: "authenticated", label: "Claude API Key" },
            usageLimits: {
              checkedAt: h.checked(MINUTE),
              windows: [],
              unavailable: {
                reason: "unsupported",
                message: "This account has no subscription limits.",
              },
            },
          }),
        ],
        [h.hub("cliproxy-nucbox", "CLI Proxy", hubAccounts)],
      ),
      h.environment(
        "env-nucbox",
        "nucbox-1",
        [],
        [h.hub("cliproxy-nucbox", "CLI Proxy", hubAccounts)],
      ),
      h.environment(
        "env-macmini",
        "Mac Mini",
        [
          h.provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: claude,
            auth: {
              status: "authenticated",
              label: "Claude Max",
              email: "work@example.com",
            },
            usageLimits: {
              checkedAt: h.checked(MINUTE),
              windows: [],
              unavailable: { reason: "probeFailed", message: "Claude timed out reading usage." },
            },
          }),
        ],
        [
          h.hub(
            "cliproxy-aws",
            "AWS proxy",
            [],
            "fetch failed: connect ECONNREFUSED 10.0.0.4:8318",
          ),
        ],
      ),
    ]);
  },
};

export function makeLimitsFixture(name: string, now: number): Fixture | null {
  return Object.hasOwn(FIXTURES, name) ? FIXTURES[name]!(now) : null;
}
