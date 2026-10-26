import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { createBrowserHistory, createHashHistory } from "@tanstack/react-router";

import { applyAppearanceContrast } from "./appearanceContrast";
import { applyAppearanceFontVariables } from "./appearanceFonts";
import { retainThreadOverlaysForThread } from "./components/chat/threadOverlayRetention";
import { startBackgroundThreadAnnouncements } from "./components/BackgroundThreadAnnouncer";
import { startSshPasswordPromptQueue } from "./components/desktop/SshPasswordPromptDialog";
import { startHostFreezeToasts } from "./components/HostFreezeToastCoordinator";
import { startLegacyThreadMigrationToast } from "./components/LegacyThreadMigrationToast";
import { startPermissionUpdateNotices } from "./components/PermissionUpdateNotice";
import { startAgentOpenedPreviews } from "./components/preview/agentOpenedPreviews";
import { startMainAppLocationTracking } from "./components/sidebar/mainAppLocation";
import { startDesktopUpdateLaunchNotice } from "./components/sidebar/updateEverythingRun";
import { startThreadNotifications } from "./components/ThreadNotificationCoordinator";
import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "./branding";
import { resolveServerBackedAppDisplayName } from "./branding.logic";
import { isElectron } from "./env";
import { useComposerDraftStore } from "./composerDraftStore";
import { startDefaultThemeAdoption } from "./hooks/useDefaultTheme";
import {
  getClientSettings,
  startModelPreferencesMigration,
  subscribeClientSettings,
} from "./hooks/useSettings";
import { startThreadVisitedMigration } from "./hooks/useThreadVisitedMigration";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { startProviderAuthDelivery } from "./providerAuthDelivery";
import { getRouter, type AppRouter } from "./router";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { primaryServerConfigAtom } from "./state/server";
import { resolveThreadRouteTarget } from "./threadRoutes";

/** Writes appearance settings onto the document, touching only the groups that changed. */
function startClientAppearance(): void {
  const root = document.documentElement;
  let applied: ClientSettings | null = null;
  const apply = () => {
    const settings = getClientSettings();
    const previous = applied;
    applied = settings;
    if (previous?.diffColorScheme !== settings.diffColorScheme) {
      root.dataset.diffColorScheme = settings.diffColorScheme;
    }
    if (previous?.chatWidth !== settings.chatWidth) {
      root.dataset.chatWidth = settings.chatWidth;
    }
    if (previous?.redesignEnabled !== settings.redesignEnabled) {
      root.toggleAttribute("data-redesign", settings.redesignEnabled);
    }
    if (previous?.appearanceContrast !== settings.appearanceContrast) {
      applyAppearanceContrast(root, settings.appearanceContrast);
    }
    if (previous?.glassOpacity !== settings.glassOpacity) {
      root.style.setProperty("--glass-opacity", `${settings.glassOpacity}%`);
      if (settings.glassOpacity === 100) {
        root.style.setProperty("--glass-blur", "0px");
      } else {
        root.style.removeProperty("--glass-blur");
      }
    }
    if (
      previous?.fontFamilySans !== settings.fontFamilySans ||
      previous.fontFamilyCode !== settings.fontFamilyCode ||
      previous.fontFamilyComposer !== settings.fontFamilyComposer ||
      previous.fontSizeInterface !== settings.fontSizeInterface ||
      previous.fontSizePrompt !== settings.fontSizePrompt ||
      previous.fontSizeCode !== settings.fontSizeCode ||
      previous.fontSmoothing !== settings.fontSmoothing
    ) {
      applyAppearanceFontVariables(root, {
        sans: settings.fontFamilySans,
        code: settings.fontFamilyCode,
        composer: settings.fontFamilyComposer,
        sizeInterface: settings.fontSizeInterface,
        sizePrompt: settings.fontSizePrompt,
        sizeCode: settings.fontSizeCode,
        smoothing: settings.fontSmoothing,
      });
    }
  };
  subscribeClientSettings(apply);
  apply();
}

function startDocumentTitle(): void {
  appAtomRegistry.subscribe(
    primaryServerConfigAtom,
    (config) => {
      document.title = resolveServerBackedAppDisplayName({
        baseName: APP_BASE_NAME,
        fallbackDisplayName: APP_DISPLAY_NAME,
        fallbackStageLabel: APP_STAGE_LABEL,
        primaryServerVersion: config?.environment.serverVersion ?? null,
      });
    },
    { immediate: true },
  );
}

/** Chat overlays belong to the thread they were opened in, so leaving its route drops them. */
function startThreadOverlayRetention(router: AppRouter): void {
  router.subscribe("onResolved", () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const draftSession =
      target?.kind === "draft"
        ? useComposerDraftStore.getState().getDraftSession(target.draftId)
        : null;
    const threadRef =
      target?.kind === "server"
        ? target.threadRef
        : draftSession
          ? scopeThreadRef(draftSession.environmentId, draftSession.threadId)
          : null;
    retainThreadOverlaysForThread(threadRef ? scopedThreadKey(threadRef) : null);
  });
}

/**
 * Starts every app-lifetime service once, before the first render, and returns the router.
 * They run for the life of the page, so their disposers are dropped here.
 */
export function startAppServices(): AppRouter {
  // Ahead of the history: the provider auth code must leave the address before anything reads it.
  startProviderAuthDelivery();

  // Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
  const router = getRouter(isElectron ? createHashHistory() : createBrowserHistory());

  if (isElectron) {
    syncDocumentElectronPlatformClasses(navigator.platform);
    syncDocumentWindowControlsOverlayClass();
  }

  startClientAppearance();
  startDocumentTitle();
  startDefaultThemeAdoption();
  startModelPreferencesMigration();
  startAgentOpenedPreviews();
  startThreadOverlayRetention(router);
  startMainAppLocationTracking(router);
  startBackgroundThreadAnnouncements(appAtomRegistry, router);
  startThreadVisitedMigration(appAtomRegistry);
  startSshPasswordPromptQueue();

  startHostFreezeToasts();
  startLegacyThreadMigrationToast();
  startPermissionUpdateNotices(router);
  startThreadNotifications(appAtomRegistry, router);
  if (isElectron) startDesktopUpdateLaunchNotice();

  return router;
}
