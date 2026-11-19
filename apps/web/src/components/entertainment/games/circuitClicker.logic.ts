/**
 * Circuit Clicker: an original incremental game. Click the core to make cycles, spend them on
 * hardware that makes cycles on its own, and unlock upgrades and achievements.
 */
export interface ClickerBuilding {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly baseCost: number;
  /** Cycles per second each one makes before upgrades. */
  readonly rate: number;
}

export const CLICKER_BUILDINGS: ReadonlyArray<ClickerBuilding> = [
  {
    id: "script",
    name: "Shell script",
    description: "Automates a click now and then.",
    baseCost: 15,
    rate: 0.1,
  },
  {
    id: "compiler",
    name: "Compiler",
    description: "Turns source into cycles.",
    baseCost: 100,
    rate: 1,
  },
  {
    id: "ci",
    name: "CI runner",
    description: "Builds around the clock.",
    baseCost: 1_100,
    rate: 8,
  },
  {
    id: "cluster",
    name: "Build cluster",
    description: "A rack of eager machines.",
    baseCost: 12_000,
    rate: 47,
  },
  {
    id: "agent",
    name: "Agent swarm",
    description: "Agents writing code that writes cycles.",
    baseCost: 130_000,
    rate: 260,
  },
  {
    id: "datacenter",
    name: "Datacenter",
    description: "Cooling not included.",
    baseCost: 1_400_000,
    rate: 1_400,
  },
  {
    id: "quantum",
    name: "Quantum core",
    description: "Every cycle at once, probably.",
    baseCost: 20_000_000,
    rate: 7_800,
  },
];

export interface ClickerUpgrade {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  /** Doubles one building's output, or the click's when null. */
  readonly building: string | null;
  /** Shown once this many of the building are owned (or total clicks for click upgrades). */
  readonly unlockAt: number;
}

const CLICKER_UPGRADES: ReadonlyArray<ClickerUpgrade> = [
  {
    id: "mech-keyboard",
    name: "Mechanical keyboard",
    description: "Clicks make twice as many cycles.",
    cost: 100,
    building: null,
    unlockAt: 25,
  },
  {
    id: "ergonomic-mouse",
    name: "Ergonomic mouse",
    description: "Clicks make twice as many cycles again.",
    cost: 5_000,
    building: null,
    unlockAt: 500,
  },
  {
    id: "cron",
    name: "Cron",
    description: "Shell scripts are twice as productive.",
    cost: 120,
    building: "script",
    unlockAt: 5,
  },
  {
    id: "lto",
    name: "Link-time optimization",
    description: "Compilers are twice as productive.",
    cost: 1_000,
    building: "compiler",
    unlockAt: 5,
  },
  {
    id: "cache",
    name: "Build cache",
    description: "CI runners are twice as productive.",
    cost: 11_000,
    building: "ci",
    unlockAt: 5,
  },
  {
    id: "scheduler",
    name: "Smart scheduler",
    description: "Build clusters are twice as productive.",
    cost: 120_000,
    building: "cluster",
    unlockAt: 5,
  },
  {
    id: "planning",
    name: "Shared planning",
    description: "Agent swarms are twice as productive.",
    cost: 1_300_000,
    building: "agent",
    unlockAt: 5,
  },
  {
    id: "liquid-cooling",
    name: "Liquid cooling",
    description: "Datacenters are twice as productive.",
    cost: 14_000_000,
    building: "datacenter",
    unlockAt: 5,
  },
  {
    id: "error-correction",
    name: "Error correction",
    description: "Quantum cores are twice as productive.",
    cost: 200_000_000,
    building: "quantum",
    unlockAt: 5,
  },
];

export interface ClickerAchievement {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly earned: (state: ClickerState) => boolean;
}

export const CLICKER_ACHIEVEMENTS: ReadonlyArray<ClickerAchievement> = [
  {
    id: "hello-world",
    name: "Hello, world",
    description: "Make your first cycle.",
    earned: (s) => s.totalCycles >= 1,
  },
  {
    id: "kilo",
    name: "Kilocycle",
    description: "Make 1,000 cycles in total.",
    earned: (s) => s.totalCycles >= 1_000,
  },
  {
    id: "mega",
    name: "Megacycle",
    description: "Make a million cycles in total.",
    earned: (s) => s.totalCycles >= 1_000_000,
  },
  {
    id: "giga",
    name: "Gigacycle",
    description: "Make a billion cycles in total.",
    earned: (s) => s.totalCycles >= 1_000_000_000,
  },
  {
    id: "clicker",
    name: "Click streak",
    description: "Click the core 1,000 times.",
    earned: (s) => s.clicks >= 1_000,
  },
  {
    id: "automation",
    name: "Automation",
    description: "Own 10 shell scripts.",
    earned: (s) => (s.owned.script ?? 0) >= 10,
  },
  {
    id: "ten-k-per-second",
    name: "Throughput",
    description: "Reach 10,000 cycles per second.",
    earned: (s) => cyclesPerSecond(s) >= 10_000,
  },
  {
    id: "full-stack",
    name: "Full stack",
    description: "Own at least one of every building.",
    earned: (s) => CLICKER_BUILDINGS.every((b) => (s.owned[b.id] ?? 0) > 0),
  },
];

export interface ClickerState {
  readonly version: 1;
  readonly cycles: number;
  readonly totalCycles: number;
  readonly clicks: number;
  readonly owned: Readonly<Record<string, number>>;
  readonly upgrades: ReadonlyArray<string>;
  readonly achievements: ReadonlyArray<string>;
  /** Epoch ms of the last tick, for offline progress. */
  readonly savedAt: number;
}

export function newClicker(now: number): ClickerState {
  return {
    version: 1,
    cycles: 0,
    totalCycles: 0,
    clicks: 0,
    owned: {},
    upgrades: [],
    achievements: [],
    savedAt: now,
  };
}

export function buildingCost(building: ClickerBuilding, owned: number): number {
  return Math.ceil(building.baseCost * 1.15 ** owned);
}

function upgradeMultiplier(state: ClickerState, building: string | null): number {
  return CLICKER_UPGRADES.filter(
    (upgrade) => upgrade.building === building && state.upgrades.includes(upgrade.id),
  ).reduce((multiplier) => multiplier * 2, 1);
}

export function cyclesPerSecond(state: ClickerState): number {
  return CLICKER_BUILDINGS.reduce(
    (total, building) =>
      total +
      (state.owned[building.id] ?? 0) * building.rate * upgradeMultiplier(state, building.id),
    0,
  );
}

export function cyclesPerClick(state: ClickerState): number {
  // Clicks also gain 1% of production, so clicking stays worthwhile late in the game.
  return upgradeMultiplier(state, null) + cyclesPerSecond(state) * 0.01;
}

function withAchievements(state: ClickerState): ClickerState {
  const earned = CLICKER_ACHIEVEMENTS.filter(
    (achievement) => !state.achievements.includes(achievement.id) && achievement.earned(state),
  );
  return earned.length === 0
    ? state
    : { ...state, achievements: [...state.achievements, ...earned.map((entry) => entry.id)] };
}

export function clickCore(state: ClickerState): ClickerState {
  const gain = cyclesPerClick(state);
  return withAchievements({
    ...state,
    cycles: state.cycles + gain,
    totalCycles: state.totalCycles + gain,
    clicks: state.clicks + 1,
  });
}

/** Advances production to `now`. Offline time counts, up to eight hours. */
export function tickClicker(state: ClickerState, now: number): ClickerState {
  const seconds = Math.min(8 * 3600, Math.max(0, (now - state.savedAt) / 1000));
  const gain = cyclesPerSecond(state) * seconds;
  return withAchievements({
    ...state,
    cycles: state.cycles + gain,
    totalCycles: state.totalCycles + gain,
    savedAt: now,
  });
}

export function buyBuilding(state: ClickerState, id: string): ClickerState {
  const building = CLICKER_BUILDINGS.find((entry) => entry.id === id);
  if (!building) return state;
  const owned = state.owned[id] ?? 0;
  const cost = buildingCost(building, owned);
  if (state.cycles < cost) return state;
  return withAchievements({
    ...state,
    cycles: state.cycles - cost,
    owned: { ...state.owned, [id]: owned + 1 },
  });
}

export function availableUpgrades(state: ClickerState): ClickerUpgrade[] {
  return CLICKER_UPGRADES.filter(
    (upgrade) =>
      !state.upgrades.includes(upgrade.id) &&
      (upgrade.building === null
        ? state.clicks >= upgrade.unlockAt
        : (state.owned[upgrade.building] ?? 0) >= upgrade.unlockAt),
  );
}

export function buyUpgrade(state: ClickerState, id: string): ClickerState {
  const upgrade = availableUpgrades(state).find((entry) => entry.id === id);
  if (!upgrade || state.cycles < upgrade.cost) return state;
  return withAchievements({
    ...state,
    cycles: state.cycles - upgrade.cost,
    upgrades: [...state.upgrades, upgrade.id],
  });
}

/** Restores a save, or null when it is not a Circuit Clicker save this version understands. */
export function parseClickerSave(raw: string | null): ClickerState | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<ClickerState>;
    if (
      value.version !== 1 ||
      typeof value.cycles !== "number" ||
      typeof value.savedAt !== "number"
    ) {
      return null;
    }
    return {
      version: 1,
      cycles: value.cycles,
      totalCycles: typeof value.totalCycles === "number" ? value.totalCycles : value.cycles,
      clicks: typeof value.clicks === "number" ? value.clicks : 0,
      owned: typeof value.owned === "object" && value.owned !== null ? value.owned : {},
      upgrades: Array.isArray(value.upgrades) ? value.upgrades : [],
      achievements: Array.isArray(value.achievements) ? value.achievements : [],
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

const SUFFIXES = ["", " thousand", " million", " billion", " trillion", " quadrillion"];

export function formatCycles(value: number): string {
  if (value < 1_000)
    return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.floor(value).toString();
  const tier = Math.min(SUFFIXES.length - 1, Math.floor(Math.log10(value) / 3));
  if (tier === 1) return Math.floor(value).toLocaleString("en-US");
  return `${(value / 1000 ** tier).toFixed(2)}${SUFFIXES[tier]}`;
}
