import { useAuth } from "@clerk/react";
import { Link } from "@tanstack/react-router";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useT } from "~/hooks/useI18n";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { RichMessage, SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { LegacyFeaturesSection } from "./SettingsPanels";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const sharingAccessLink = (children: string) => (
  <Link to="/settings/access" className="underline underline-offset-2">
    {children}
  </Link>
);

const connectionsLink = (children: string) => (
  <Link to="/settings/connections" className="underline underline-offset-2">
    {children}
  </Link>
);

const devicesLink = (children: string) => (
  <Link to="/settings/devices" className="underline underline-offset-2">
    {children}
  </Link>
);

const simlockLink = (children: string) => (
  <a
    href="https://incubator.callstack.com/simlock/"
    target="_blank"
    rel="noreferrer"
    className="underline underline-offset-2"
  >
    {children}
  </a>
);

/** Features still settling in, and legacy behavior kept for people who rely on it. */
export function LabsSettingsPanel() {
  const t = useT();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={t("settings.system.labs.beta")}>
        <BoringSidebarRow />
        <BoringSidebarMultilineRow />
        {/* Clerk is only mounted when this build has T3 Connect. */}
        {hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />}
        <LinkedEnvironmentsRow />
        <SimlockHostsRow />
      </SettingsSection>
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

function BoringSidebarRow() {
  const t = useT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      title={t("settings.system.labs.boringSidebar.title")}
      description={t("settings.system.labs.boringSidebar.description")}
      control={
        <Switch
          checked={settings.boringSidebarEnabled || settings.legacySidebarEnabled}
          // Turning it off also clears the opt-in of the removed legacy sidebar.
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarEnabled: Boolean(checked), legacySidebarEnabled: false })
          }
          aria-label={t("settings.system.labs.boringSidebar.title")}
        />
      }
    />
  );
}

function BoringSidebarMultilineRow() {
  const t = useT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      title={t("settings.system.labs.boringMultiline.title")}
      description={t("settings.system.labs.boringMultiline.description")}
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label={t("settings.system.labs.boringMultiline.title")}
        />
      }
    />
  );
}

/** Signed out of T3 Connect, the row offers to sign in instead of its switch. */
function GuestLinksRowWithSignIn() {
  const t = useT();
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...searchableSetting("guest-links")}
      title={t("settings.system.labs.guestLinks.title")}
      description={t("settings.system.labs.guestLinks.signInDescription")}
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          {t("settings.system.labs.signIn")}
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const t = useT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      title={t("settings.system.labs.guestLinks.title")}
      settingKeys={["guestSharingEnabled"]}
      description={
        <RichMessage
          message={t("settings.system.labs.guestLinks.description")}
          tags={{ link: sharingAccessLink }}
        />
      }
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label={t("settings.system.labs.guestLinks.title")}
        />
      }
    />
  );
}

function LinkedEnvironmentsRow() {
  const t = useT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      title={t("settings.system.labs.linkedEnvs.title")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <RichMessage
          message={t("settings.system.labs.linkedEnvs.description")}
          tags={{ link: connectionsLink }}
        />
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label={t("settings.system.labs.linkedEnvs.title")}
        />
      }
    />
  );
}

function SimlockHostsRow() {
  const t = useT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      title={t("settings.system.labs.simlock.title")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <RichMessage
          message={t("settings.system.labs.simlock.description")}
          tags={{ simlock: simlockLink, link: devicesLink }}
        />
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label={t("settings.system.labs.simlock.aria")}
        />
      }
    />
  );
}
