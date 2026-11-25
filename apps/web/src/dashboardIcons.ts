import { ProjectIconOverride } from "@t3tools/contracts";
import { DASHBOARD_ICONS_CDN_URL } from "@t3tools/shared/dashboardIcons";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

export type DashboardIcon = Extract<ProjectIconOverride, { kind: "dashboard-icon" }>;

export interface DashboardIconEntry {
  readonly icon: DashboardIcon;
  /** Name then aliases, as lowercase letters and digits. */
  readonly keys: ReadonlyArray<string>;
}

const isProjectIcon = Schema.is(ProjectIconOverride);
const decodeEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    base: Schema.Literals(["svg", "png", "webp"]),
    aliases: Schema.optional(Schema.Array(Schema.String)),
    // `light` is the light-coloured file, drawn on dark backgrounds.
    colors: Schema.optional(
      Schema.Struct({
        light: Schema.optional(Schema.String),
        dark: Schema.optional(Schema.String),
      }),
    ),
  }),
);

const compact = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Builds the searchable list from dashboard-icons' metadata.json. */
export function parseDashboardIcons(metadata: unknown): ReadonlyArray<DashboardIconEntry> {
  if (typeof metadata !== "object" || metadata === null) return [];
  return Object.entries(metadata).flatMap(([name, raw]) => {
    const entry = Option.getOrUndefined(decodeEntry(raw));
    if (!entry) return [];
    const file = `${entry.colors?.dark ?? name}.${entry.base}`;
    const darkFile = `${entry.colors?.light ?? name}.${entry.base}`;
    const icon: DashboardIcon = {
      kind: "dashboard-icon",
      name,
      file,
      ...(darkFile === file ? {} : { darkFile }),
    };
    return isProjectIcon(icon)
      ? [{ icon, keys: [name, ...(entry.aliases ?? [])].map(compact) }]
      : [];
  });
}

function ranked(
  entries: ReadonlyArray<DashboardIconEntry>,
  rankOf: (entry: DashboardIconEntry) => number | undefined,
  limit: number,
): ReadonlyArray<DashboardIcon> {
  return entries
    .flatMap((entry) => {
      const rank = rankOf(entry);
      return rank === undefined ? [] : [{ rank, icon: entry.icon }];
    })
    .toSorted((a, b) => a.rank - b.rank || a.icon.name.length - b.icon.name.length)
    .slice(0, limit)
    .map(({ icon }) => icon);
}

/** Searches names and aliases; with no query, suggests icons named in the project name. */
export function findDashboardIcons(
  entries: ReadonlyArray<DashboardIconEntry>,
  query: string,
  projectName: string,
): ReadonlyArray<DashboardIcon> {
  const search = compact(query);
  if (search) {
    return ranked(
      entries,
      ({ keys: [name = "", ...aliases] }) =>
        name === search
          ? 0
          : name.startsWith(search)
            ? 1
            : name.includes(search) || aliases.some((alias) => alias.includes(search))
              ? 2
              : undefined,
      60,
    );
  }
  const words = [compact(projectName), ...projectName.toLowerCase().split(/[^a-z0-9]+/)].filter(
    (word) => word.length >= 3,
  );
  return ranked(
    entries,
    ({ keys: [name = ""] }) =>
      words.includes(name)
        ? 0
        : words.some((word) => word.length >= 4 && name.startsWith(word))
          ? 1
          : undefined,
    20,
  );
}

async function loadDashboardIcons() {
  const response = await fetch(`${DASHBOARD_ICONS_CDN_URL}/metadata.json`);
  if (!response.ok) throw new Error(`dashboard-icons metadata answered ${response.status}`);
  return parseDashboardIcons(await response.json());
}

// Kept for the session; jsDelivr's cache headers keep repeat sessions off the network.
export const dashboardIconsAtom = Atom.make(Effect.promise(loadDashboardIcons)).pipe(
  Atom.keepAlive,
  Atom.withLabel("dashboard-icons"),
);
