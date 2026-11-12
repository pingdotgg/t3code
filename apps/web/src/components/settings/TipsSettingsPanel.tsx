import { AuthOrchestrationOperateScope, EnvironmentId, type TipId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { persistClientSettingsUpdate, useClientSettings } from "~/hooks/useSettings";
import { useAllEnvironmentShellsBootstrapped, useServerConfigs } from "~/state/entities";
import { useEnvironmentsWithScope } from "~/state/session";
import {
  useConnectedEnvironmentIds,
  useEnvironment,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { TIPS, TIPS_DOCS_URL, type Tip, type TipAction } from "~/tips/catalog";
import {
  MAX_DECK_SIZE,
  deriveDeck,
  isTipRetired,
  isTipTried,
  tipAgeDays,
  tipProgress,
} from "~/tips/tipsState";
import { markTipDone, useTipsState } from "~/tips/tipsStorage";
import {
  isTipAvailable,
  markTipOpened,
  recordTipEvent,
  recordTipEvidence,
  setTipDismissed,
  sendPendingTipEvents,
  setTipTried,
  showTipNow,
  tipEventEnvironmentId,
} from "~/tips/tipsStore";
import { TipActions, withoutDoneActions } from "../chat/NewThreadTips";
import { Checkbox } from "../ui/checkbox";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { searchableSetting, settingsSearchHash } from "./settingsSearch";

/** Every tip, what this client detected, and the way back for each hidden one. */
export function TipsSettingsPanel() {
  const navigate = useNavigate();
  const enabled = useClientSettings((settings) => settings.newThreadTipsEnabled);
  const boringSidebarOn = useClientSettings((settings) => settings.boringSidebarEnabled);
  // The machine Settings has selected (even offline, so Devices shows its reconnect notice),
  // else this client's own, else any connected one. Hosted web has no primary.
  const settingsScope = useOptionalSettingsScope();
  const selectedMachine = settingsScope?.search.machine;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const environmentId =
    (selectedMachine === undefined ? undefined : EnvironmentId.make(selectedMachine)) ??
    settingsScope?.environment?.environmentId ??
    primaryEnvironmentId ??
    connectedEnvironmentIds[0] ??
    null;
  // The scope picker is hidden on this page, so name the machine the statuses describe.
  const checkedMachine = useEnvironment(environmentId)?.label;
  // Analytics go only to a connected machine: an offline selection must not become a tip's home.
  const eventEnvironmentId = tipEventEnvironmentId(
    [environmentId, settingsScope?.environment?.environmentId, primaryEnvironmentId],
    connectedEnvironmentIds,
  );
  const shellsReady = useAllEnvironmentShellsBootstrapped();
  const providers = useEnvironmentProviders();
  const configs = useServerConfigs();
  const state = useTipsState();
  // Voice may run on any connected machine, so labels follow every one's permission.
  const operable = useEnvironmentsWithScope(
    [
      ...new Set([...connectedEnvironmentIds, ...(environmentId === null ? [] : [environmentId])]),
    ].map((id) => ({ environmentId: id })),
    AuthOrchestrationOperateScope,
  );
  const isAvailable = (id: TipId) =>
    isTipAvailable(id, environmentId, undefined, {
      providers,
      configs,
      canOperate: (on) => operable.has(on),
    });
  const deck = new Set(deriveDeck(TIPS, state, isAvailable));
  const [openedAt] = useState(() => Date.now());
  const ageDays = tipAgeDays(state, openedAt);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records use detected from environment snapshots into localStorage when the page opens or regains focus
  useEffect(() => {
    if (!shellsReady) return;
    const record = () => {
      for (const [id, use] of recordTipEvidence()) {
        markTipDone(id, {
          at: use.at,
          on: use.on === undefined ? undefined : EnvironmentId.make(use.on),
        });
      }
      sendPendingTipEvents(eventEnvironmentId);
    };
    record();
    // Use elsewhere, such as on the phone, can arrive while this page stays open.
    window.addEventListener("focus", record);
    return () => window.removeEventListener("focus", record);
  }, [shellsReady, eventEnvironmentId]);

  const setEnabled = (on: boolean) => {
    persistClientSettingsUpdate((current) => ({ ...current, newThreadTipsEnabled: on })).then(
      () => void recordTipEvent(eventEnvironmentId, { event: on ? "enabled" : "disabled" }),
      () => toastManager.add({ type: "error", title: "Could not save the tips setting" }),
    );
  };
  const runAction = (tip: Tip, action: TipAction) => {
    // Opening a tip already tried is not the tip leading anyone anywhere.
    if (!isTipTried(tipProgress(state, tip.id))) markTipOpened(tip.id, eventEnvironmentId);
    if (action.kind === "boring-sidebar") {
      // Settings has no Undo, so the save itself is the use.
      persistClientSettingsUpdate((current) => ({ ...current, boringSidebarEnabled: true })).then(
        () => {
          markTipDone("boring-sidebar");
          // Send to this page's machine; the send after saving has no machine to name here.
          sendPendingTipEvents(eventEnvironmentId);
        },
        () => toastManager.add({ type: "error", title: "Could not save the sidebar setting" }),
      );
    } else if (action.kind === "setting") {
      void navigate({
        to: action.to,
        hash: settingsSearchHash(action.target),
        // Per-machine settings open on one machine, as they do from the strip. Others drop this
        // page's machine, which may be offline, so they open on every machine.
        search:
          action.scoped && environmentId !== null
            ? { machine: environmentId }
            : { machine: undefined, project: undefined, checkout: undefined },
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    }
  };
  const status = (tip: Tip) => {
    const progress = tipProgress(state, tip.id);
    if (isTipTried(progress)) return "Tried";
    if (progress.dismissedAt !== undefined) return "Hidden";
    if (!enabled) return "Tips are off";
    // The strip also checks the draft's project, so these say what is planned, not promised.
    if (deck.has(tip.id)) return "In rotation";
    if (progress.shownAt !== undefined) return "Shown";
    if (ageDays < tip.minAgeDays) return "Later";
    if (!isAvailable(tip.id)) return "Not available here";
    // Newer tips pushed it out of the strip before the user reached it.
    if (progress.introducedAt !== undefined) return "Not shown";
    // Tips arrive one per active day, so a due tip may still wait behind others.
    return "Up next";
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="tips" title="Tips">
        <SettingsRow
          {...searchableSetting("new-thread-tips")}
          description={`Show up to ${MAX_DECK_SIZE} tips under the composer on new threads. New tips arrive slowly, and a tip stops showing once T3 Code sees you use its feature.`}
          control={
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
              aria-label="Tips on new threads"
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        id="all-tips"
        title={
          checkedMachine !== undefined && environmentId !== primaryEnvironmentId
            ? `All tips for ${checkedMachine}`
            : "All tips"
        }
        headerAction={
          <InlineButton
            tone="muted"
            render={<a href={TIPS_DOCS_URL} target="_blank" rel="noreferrer noopener" />}
          >
            View on GitHub
          </InlineButton>
        }
      >
        {TIPS.map((tip) => {
          const progress = tipProgress(state, tip.id);
          const retired = isTipRetired(progress);
          return (
            <SettingsRow
              key={tip.id}
              title={tip.lead}
              status={status(tip)}
              description={
                <>
                  {tip.body}
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <TipActions
                      tip={withoutDoneActions(tip, boringSidebarOn)}
                      onAction={(action) => runAction(tip, action)}
                    />
                    {progress.dismissedAt !== undefined && !isTipTried(progress) ? (
                      <InlineButton
                        tone="muted"
                        onClick={() => setTipDismissed(tip.id, false, eventEnvironmentId)}
                      >
                        Restore
                      </InlineButton>
                    ) : !enabled || retired || deck.has(tip.id) || !isAvailable(tip.id) ? null : (
                      <InlineButton tone="muted" onClick={() => showTipNow(tip.id)}>
                        Add to strip
                      </InlineButton>
                    )}
                  </span>
                </>
              }
              control={
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    aria-label={`Tried it: ${tip.lead}`}
                    checked={isTipTried(progress)}
                    onCheckedChange={(checked) =>
                      setTipTried(tip.id, Boolean(checked), eventEnvironmentId)
                    }
                  />
                  Tried it
                </label>
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
