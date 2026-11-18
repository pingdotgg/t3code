import type { RightPanelMenuChoice } from "@t3tools/contracts";
import { Navigate } from "@tanstack/react-router";
import { FileDiff, Files, Globe2, MessagesSquare, Smartphone, TerminalSquare } from "lucide-react";
import type { ComponentType } from "react";

import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { FORK_SURFACES } from "../dashboard/dashboardSurface";
import { RIGHT_PANEL_SETTINGS_COPY as COPY } from "../forkCopy";
import { isBoardHost, useBoardHostRole } from "../whiteboard/role";
import {
  parseMenuLayer,
  RIGHT_PANEL_MENU_ITEM_IDS,
  type RightPanelMenuItemId,
  setMenuChoice,
} from "./menu.logic";

interface MenuItemRow {
  readonly id: RightPanelMenuItemId;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly builtInKey: string;
}

const forkRow = (kind: keyof typeof FORK_SURFACES) => ({
  label: FORK_SURFACES[kind].label,
  icon: FORK_SURFACES[kind].icon,
  builtInKey: FORK_SURFACES[kind].shortcut as string,
});

// One row per menu id (the type fails without one). The launchers read upstream letters from
// their own items; these copies only name this page's defaults, so keep them equal.
const MENU_ITEM_ROWS = {
  browser: { label: "Browser", icon: Globe2, builtInKey: "B" },
  terminal: { label: "Terminal", icon: TerminalSquare, builtInKey: "T" },
  files: { label: "Files", icon: Files, builtInKey: "F" },
  diff: { label: "Diff", icon: FileDiff, builtInKey: "D" },
  "pull-request": { label: "Pull request", icon: PullRequestGlyph.pullRequest, builtInKey: "P" },
  "pull-requests": { label: "Linked pull requests", icon: PullRequestGlyph.link, builtInKey: "L" },
  device: { label: "Device", icon: Smartphone, builtInKey: "M" },
  "side-chat": { label: "Side chat", icon: MessagesSquare, builtInKey: "S" },
  replies: forkRow("replies"),
  dashboard: forkRow("dashboard"),
  whiteboard: forkRow("whiteboard"),
} satisfies Record<RightPanelMenuItemId, Omit<MenuItemRow, "id">>;

const MENU_ITEMS: ReadonlyArray<MenuItemRow> = RIGHT_PANEL_MENU_ITEM_IDS.map((id) => ({
  id,
  ...MENU_ITEM_ROWS[id],
}));

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];

function writeChoice(id: RightPanelMenuItemId, choice: RightPanelMenuChoice) {
  void updateClientSettings({
    rightPanelMenuOverrides: setMenuChoice(getClientSettings().rightPanelMenuOverrides, id, choice),
  });
}

function MenuItemSettingsRow(props: {
  readonly item: MenuItemRow;
  readonly machine: RightPanelMenuChoice | undefined;
  readonly browser: RightPanelMenuChoice;
}) {
  const { item, browser } = props;
  const { hidden, key } = browser;
  const defaultKey = props.machine?.key ?? item.builtInKey;
  const visibility = hidden === undefined ? "default" : hidden ? "hidden" : "shown";
  const letter = key === undefined ? "default" : key === "" ? "none" : key;
  const visibilityLabel = (value: string | null) =>
    value === "hidden"
      ? COPY.hidden
      : value === "shown"
        ? COPY.shown
        : COPY.byDefault(props.machine?.hidden === true ? COPY.hidden : COPY.shown);
  const letterLabel = (value: string | null) =>
    value === "none"
      ? COPY.noLetter
      : value === null || value === "default"
        ? COPY.byDefault(defaultKey || COPY.none)
        : value;
  const Icon = item.icon;
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-4 shrink-0" />
          {item.label}
        </span>
      }
      resetAction={
        hidden === undefined && key === undefined ? null : (
          <SettingResetButton
            ariaLabel={COPY.resetItem(item.label)}
            onClick={() => writeChoice(item.id, {})}
          />
        )
      }
      control={
        <div className="flex w-full flex-col gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:flex-row">
          <Select
            value={visibility}
            onValueChange={(value) =>
              writeChoice(item.id, {
                ...(key === undefined ? {} : { key }),
                ...(value === "default" || value === null ? {} : { hidden: value === "hidden" }),
              })
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full @min-[32rem]/settings-row:w-40"
              aria-label={COPY.visibilityOf(item.label)}
            >
              <SelectValue>{visibilityLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {["default", "shown", "hidden"].map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {visibilityLabel(value)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={letter}
            onValueChange={(value) =>
              writeChoice(item.id, {
                ...(hidden === undefined ? {} : { hidden }),
                ...(value === "default" || value === null
                  ? {}
                  : { key: value === "none" ? "" : value }),
              })
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full @min-[32rem]/settings-row:w-40"
              aria-label={COPY.letterOf(item.label)}
            >
              <SelectValue>{letterLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {["default", "none", ...LETTERS].map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {letterLabel(value)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

export function RightPanelMenuSettingsPanel() {
  const role = useBoardHostRole();
  const overrides = useClientSettings((settings) => settings.rightPanelMenuOverrides);
  if (role === "unknown") return null;
  if (!isBoardHost(role)) return <Navigate to="/settings/general" replace />;
  const machine = parseMenuLayer(role.menu);
  const browser = parseMenuLayer(overrides);
  return (
    <SettingsPageContainer>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">{COPY.intro}</p>
      <SettingsSection
        id="right-panel-menu"
        title={COPY.section}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={Object.keys(browser).length === 0}
            onClick={() => void updateClientSettings({ rightPanelMenuOverrides: {} })}
          >
            {COPY.resetAll}
          </Button>
        }
      >
        {MENU_ITEMS.map((item) => (
          <MenuItemSettingsRow
            key={item.id}
            item={item}
            machine={machine[item.id]}
            browser={browser[item.id] ?? {}}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
