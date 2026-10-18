import type { NavigationState, PartialState } from "@react-navigation/native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

export const SETTINGS_SECTION_LABELS = {
  SettingsAuth: "T3 Account",
  SettingsEnvironments: "Environments",
  SettingsNotifications: "Notifications",
  SettingsAppearance: "Appearance",
  SettingsKeyboard: "Keyboard",
  SettingsMicrophone: "Microphone",
  SettingsScheduledTasks: "Scheduled tasks",
  SettingsProjectOverview: "Overview",
  SettingsOrganization: "Organization",
  SettingsThreads: "Thread behavior",
  SettingsFollowUp: "Follow-ups",
  SettingsArchive: "Archived Threads",
  SettingsProviderAccounts: "Provider accounts",
  SettingsEnvironmentNewThreads: "New threads",
  SettingsEnvironmentSourceControl: "Source control",
  SettingsEnvironmentAgentBehavior: "Agent behavior",
  SettingsEnvironmentMaintenance: "Maintenance",
  SettingsUsage: "Usage",
  SettingsAbout: "About T3 Code",
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTION_LABELS;

const SETTINGS_SECTION_ICONS: Readonly<Record<SettingsSection, AppSymbolName>> = {
  SettingsAuth: "person.crop.circle",
  SettingsEnvironments: "desktopcomputer",
  SettingsNotifications: "bell.badge",
  SettingsAppearance: "paintbrush",
  SettingsKeyboard: "keyboard",
  SettingsMicrophone: "mic",
  SettingsScheduledTasks: "clock",
  SettingsProjectOverview: "folder",
  SettingsOrganization: "folder",
  SettingsThreads: "text.bubble",
  SettingsFollowUp: "arrow.turn.left.up",
  SettingsArchive: "archivebox",
  SettingsProviderAccounts: "person.crop.circle",
  SettingsEnvironmentNewThreads: "text.bubble",
  SettingsEnvironmentSourceControl: "arrow.triangle.branch",
  SettingsEnvironmentAgentBehavior: "text.alignleft",
  SettingsEnvironmentMaintenance: "arrow.clockwise",
  SettingsUsage: "chart.bar.xaxis",
  SettingsAbout: "info.circle",
};

/** Pages reached from inside a section, highlighted as that section. */
const SECTION_BY_SUBPAGE: Readonly<Record<string, SettingsSection>> = {
  Settings: "SettingsEnvironments",
  SettingsEnvironmentDetail: "SettingsEnvironments",
  SettingsEnvironmentNew: "SettingsEnvironments",
  SettingsProjectGrouping: "SettingsOrganization",
  SettingsScheduledTaskNew: "SettingsScheduledTasks",
  SettingsScheduledTaskEdit: "SettingsScheduledTasks",
  SettingsScheduledTaskBranch: "SettingsScheduledTasks",
  SettingsScheduledTaskModel: "SettingsScheduledTasks",
  SettingsClientStorage: "SettingsAbout",
  SettingsDiagnostics: "SettingsAbout",
  SettingsOpenSourceLicenses: "SettingsAbout",
  SettingsOpenSourceLicense: "SettingsAbout",
  SettingsUsageAccount: "SettingsUsage",
  SettingsWaitlist: "SettingsAuth",
};

export function isSettingsSection(page: string): page is SettingsSection {
  return Object.hasOwn(SETTINGS_SECTION_LABELS, page);
}

export function settingsSectionForPage(page: string): SettingsSection | null {
  if (isSettingsSection(page)) return page;
  return Object.hasOwn(SECTION_BY_SUBPAGE, page) ? SECTION_BY_SUBPAGE[page]! : null;
}

export interface SettingsNavigationItem {
  readonly section: SettingsSection;
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly value?: string;
  readonly valuePosition?: "trailing";
  readonly disabled?: boolean;
}

export interface SettingsNavigationGroup {
  readonly title: string;
  readonly items: ReadonlyArray<SettingsNavigationItem>;
}

export function buildSettingsNavigationGroups(input: {
  /** Present only when T3 Connect is configured. */
  readonly account: { readonly label: string; readonly loading: boolean } | null;
  readonly environmentCount: number;
  readonly deviceInputSettings: boolean;
  readonly projectLabel: string | null;
  readonly serverSettingsAvailable: boolean;
}): ReadonlyArray<SettingsNavigationGroup> {
  const item = (
    section: SettingsSection,
    extra?: Omit<SettingsNavigationItem, "section" | "label" | "icon">,
  ): SettingsNavigationItem => ({
    section,
    label: SETTINGS_SECTION_LABELS[section],
    icon: SETTINGS_SECTION_ICONS[section],
    ...extra,
  });
  const serverItem = (section: SettingsSection) =>
    item(section, { disabled: !input.serverSettingsAvailable });
  return [
    {
      title: "Connections",
      items: [
        ...(input.account
          ? [item("SettingsAuth", { value: input.account.label, disabled: input.account.loading })]
          : []),
        item("SettingsEnvironments", {
          value: `${input.environmentCount}`,
          valuePosition: "trailing",
        }),
        ...(input.account ? [item("SettingsNotifications")] : []),
      ],
    },
    {
      title: "Interface",
      items: [
        item("SettingsAppearance"),
        ...(input.deviceInputSettings
          ? [item("SettingsKeyboard"), item("SettingsMicrophone")]
          : []),
      ],
    },
    { title: "Automations", items: [item("SettingsScheduledTasks")] },
    {
      title: "Projects & threads",
      items: [
        ...(input.projectLabel !== null
          ? [item("SettingsProjectOverview", { value: input.projectLabel })]
          : []),
        item("SettingsOrganization"),
        item("SettingsThreads"),
        item("SettingsFollowUp"),
        item("SettingsArchive"),
      ],
    },
    {
      title: "Server settings",
      items: [
        serverItem("SettingsProviderAccounts"),
        serverItem("SettingsEnvironmentNewThreads"),
        serverItem("SettingsEnvironmentSourceControl"),
        serverItem("SettingsEnvironmentAgentBehavior"),
        serverItem("SettingsEnvironmentMaintenance"),
      ],
    },
    { title: "App", items: [item("SettingsUsage"), item("SettingsAbout")] },
  ];
}

/** Nested state for a `SettingsSheet` route showing `page` as a sidebar section. */
export function settingsSectionState(page: string): PartialState<NavigationState> {
  return {
    routes: [
      page === "SettingsAuth"
        ? { name: page }
        : { name: "SettingsContent", state: { routes: [{ name: page }] } },
    ],
  };
}

interface NavigationStateLike {
  readonly index?: number | undefined;
  readonly routes: ReadonlyArray<NavigationRouteLike>;
}

interface NavigationRouteLike {
  readonly name: string;
  readonly params?: object | undefined;
  readonly state?: NavigationStateLike | undefined;
}

/** A nested navigator that has not mounted yet only exists as `{ screen, params }`. */
function nestedStack(route: NavigationRouteLike): NavigationStateLike | null {
  if (route.state) return route.state;
  const params = route.params;
  if (!params || !("screen" in params) || typeof params.screen !== "string") return null;
  const nested =
    "params" in params && typeof params.params === "object" && params.params !== null
      ? params.params
      : undefined;
  return { routes: [{ name: params.screen, params: nested }] };
}

function focusedIndex(state: NavigationStateLike) {
  return state.index ?? state.routes.length - 1;
}

function openRoutes(state: NavigationStateLike) {
  return state.routes.slice(0, focusedIndex(state) + 1);
}

const pageSeed = (route: NavigationRouteLike) => ({ name: route.name, params: route.params });

/**
 * Nested state that reopens a `SettingsSheet` route on the page it showed as it
 * moves into the sidebar layout, where each section is a root page and the index
 * shows Environments, or out of it into a sheet, where sections push from the index.
 */
export function settingsSheetStateFor(
  route: NavigationRouteLike,
  intoSidebar: boolean,
): PartialState<NavigationState> {
  const [root = { name: "SettingsContent" }, ...above] = openRoutes(
    nestedStack(route) ?? { routes: [{ name: "SettingsContent" }] },
  );
  const sheetAbove = above.map(pageSeed);
  if (root.name !== "SettingsContent") {
    const routes = [pageSeed(root), ...sheetAbove];
    return { routes: intoSidebar ? routes : [{ name: "SettingsContent" }, ...routes] };
  }
  const [first = { name: "Settings" }, ...rest] = openRoutes(
    nestedStack(root) ?? { routes: [{ name: "Settings" }] },
  ).map(pageSeed);
  if (!intoSidebar) {
    const pages =
      first.name === "Settings"
        ? [first, { name: "SettingsEnvironments" }, ...rest]
        : [{ name: "Settings" }, first, ...rest];
    return { routes: [{ name: "SettingsContent", state: { routes: pages } }, ...sheetAbove] };
  }
  const pages = first.name === "Settings" ? rest : [first, ...rest];
  if (pages.length === 0 && sheetAbove.length > 0) return { routes: sheetAbove };
  return {
    routes: [
      { name: "SettingsContent", state: { routes: pages.length > 0 ? pages : [first] } },
      ...sheetAbove,
    ],
  };
}

/**
 * The sidebar section for an open `SettingsSheet` route, and whether its
 * section page is showing without anything pushed above it.
 */
export function resolveSettingsLocation(route: NavigationRouteLike): {
  readonly section: SettingsSection | null;
  readonly atSectionRoot: boolean;
} {
  const sheet = nestedStack(route) ?? { routes: [{ name: "SettingsContent" }] };
  const sheetIndex = focusedIndex(sheet);
  const sheetRoute = sheet.routes[sheetIndex];
  if (!sheetRoute) return { section: null, atSectionRoot: false };
  if (sheetRoute.name !== "SettingsContent") {
    return {
      section: settingsSectionForPage(sheetRoute.name),
      atSectionRoot: sheetIndex === 0 && isSettingsSection(sheetRoute.name),
    };
  }
  const content = nestedStack(sheetRoute) ?? { routes: [{ name: "Settings" }] };
  const contentIndex = focusedIndex(content);
  const page = content.routes[contentIndex]?.name ?? "Settings";
  return {
    section: settingsSectionForPage(page),
    atSectionRoot:
      sheetIndex === 0 && contentIndex === 0 && (page === "Settings" || isSettingsSection(page)),
  };
}
