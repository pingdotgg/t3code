import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { normalizeSearchText } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={
        permissionMessage ??
        "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open."
      }
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(
                  "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                );
                return;
              }
              setRequesting(true);
              const permission = await settlePromise(() => Notification.requestPermission());
              setRequesting(false);
              if (permission._tag === "Failure") {
                setPermissionMessage(
                  "Notifications are unavailable in this browser. Sound only is still available.",
                );
                return;
              }
              if (permission.value !== "granted") {
                setPermissionMessage(
                  "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                );
                return;
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
            <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function NotificationProjectsSettings() {
  const selected = useScopedSettings((settings) => settings.notificationProjects);
  const updateSettings = useUpdateScopedSettings();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [query, setQuery] = useState("");
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const showEnvironment = new Set(projects.map((project) => project.environmentId)).size > 1;
  const normalizedQuery = normalizeSearchText(query);
  const options = projects
    .map((project) => ({
      project,
      key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      environmentLabel: showEnvironment
        ? (environmentLabels.get(project.environmentId) ?? null)
        : null,
    }))
    .filter(
      (option) =>
        normalizedQuery === "" ||
        normalizeSearchText(`${option.project.title} ${option.environmentLabel ?? ""}`).includes(
          normalizedQuery,
        ),
    )
    .toSorted((left, right) => left.project.title.localeCompare(right.project.title));
  const summary =
    selected.length === 0
      ? "All projects"
      : `${selected.length} ${selected.length === 1 ? "project" : "projects"}`;
  const setProject = (key: string, checked: boolean) => {
    const current = getClientSettings().notificationProjects.filter((entry) => entry !== key);
    updateSettings({ notificationProjects: checked ? [...current, key] : current });
  };

  return (
    <SettingsRow
      title={searchableSetting("notification-projects").title}
      description="Only alert for threads in these projects."
      resetAction={
        selected.length === 0 ? null : (
          <SettingResetButton
            label="notification projects"
            onClick={() => updateSettings({ notificationProjects: [] })}
          />
        )
      }
      control={
        <Menu
          onOpenChange={(open) => {
            if (!open) setQuery("");
          }}
        >
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between sm:w-56"
                aria-label={`Notification projects: ${summary}`}
              />
            }
          >
            {summary}
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuSearchInput
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search projects"
              aria-label="Search projects"
            />
            <MenuCheckboxItem
              checked={selected.length === 0}
              onCheckedChange={() => updateSettings({ notificationProjects: [] })}
            >
              All projects
            </MenuCheckboxItem>
            <MenuSeparator />
            {options.length === 0 ? <MenuItem disabled>No projects found</MenuItem> : null}
            {options.map(({ project, key, environmentLabel }) => (
              <MenuCheckboxItem
                key={key}
                checked={selected.includes(key)}
                onCheckedChange={(checked) => setProject(key, checked)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={project} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  {environmentLabel ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {environmentLabel}
                    </span>
                  ) : null}
                </span>
              </MenuCheckboxItem>
            ))}
          </MenuPopup>
        </Menu>
      }
    />
  );
}
