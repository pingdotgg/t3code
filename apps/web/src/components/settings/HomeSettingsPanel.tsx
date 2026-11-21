import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  HomeSettings,
  HomeWatch,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { homeFailure, type HomeFailure } from "../home/homeErrors";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { scheduledTaskDefaultModel } from "./scheduledTasksSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function HomeSettingsPanel() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = (environment ?? connectedEnvironments[0])?.environmentId ?? null;
  return environmentId === null ? null : <EnvironmentHomeSettings environmentId={environmentId} />;
}

function EnvironmentHomeSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const home = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.home ?? null,
  );
  return home === null ? null : <HomeSettingsContent environmentId={environmentId} home={home} />;
}

function HomeSettingsContent({
  environmentId,
  home,
}: {
  readonly environmentId: EnvironmentId;
  readonly home: HomeSettings;
}) {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(serverEnvironment.enableHome.permissionAtom(environmentId));
  const enable = useAtomCommand(serverEnvironment.enableHome, { label: "home enable" });
  const disable = useAtomCommand(serverEnvironment.disableHome, { label: "home disable" });
  const reset = useAtomCommand(serverEnvironment.resetHome, { label: "home reset" });
  const setModel = useAtomCommand(serverEnvironment.setHomeModel, { label: "home set model" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HomeFailure | null>(null);
  // Picked while Home is off, it is sent along when Home is turned on.
  const [picked, setPicked] = useState<ModelSelection | null>(null);

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const selection =
    picked ??
    home.modelSelection ??
    scheduledTaskDefaultModel(settings, null, instanceEntries) ??
    null;
  const shownInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const shownModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    shownInstanceId,
    shownModel,
  );
  const target = { environmentId, input: {} };

  const run = async (action: () => ReturnType<typeof enable | typeof disable>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await action();
    setBusy(false);
    setFailure(homeFailure(result, m));
  };
  const toggle = (on: boolean) =>
    run(() =>
      on
        ? enable({ environmentId, input: selection === null ? {} : { modelSelection: selection } })
        : disable(target),
    );
  const pickModel = (instanceId: ProviderInstanceId, model: string) => {
    const next = { instanceId, model };
    setPicked(next);
    if (home.enabled) void run(() => setModel({ environmentId, input: { modelSelection: next } }));
  };
  const startFresh = async () => {
    const confirmed = await (requestConfirmDialog(
      gt(
        "Start Home fresh? It begins a new conversation. Its notes and watches stay, and the old thread is kept.",
      ),
    ) ?? Promise.resolve(false));
    if (confirmed) await run(() => reset(target));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...setting("home")}>
        <SettingsRow
          title={gt("Enable Home")}
          description={gt(
            "One agent on this environment that works across your projects and linked environments.",
          )}
          status={
            failure === null ? null : (
              <span className="text-destructive" role="alert">
                {failure.message}
              </span>
            )
          }
          control={
            <Switch
              checked={home.enabled}
              disabled={!canOperate || busy}
              onCheckedChange={(checked) => void toggle(Boolean(checked))}
              aria-label={gt("Enable Home")}
            />
          }
        />
        <SettingsRow
          title={gt("Model")}
          description={gt("The model Home runs on.")}
          control={
            <ProviderModelPicker
              environmentId={environmentId}
              disabled={!canOperate || busy}
              activeInstanceId={shownInstanceId}
              model={shownModel}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              isComposerOwned={false}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onInstanceModelChange={pickModel}
            />
          }
        />
        <SettingsRow
          title={gt("Start fresh")}
          description={gt("Begin a new Home conversation. Notes and watches carry over.")}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canOperate || busy || !home.enabled}
              onClick={() => void startFresh()}
            >
              <T>Start fresh</T>
            </Button>
          }
        />
      </SettingsSection>
      <HomeNotesSection environmentId={environmentId} canEdit={canOperate} />
      <HomeWatchesSection environmentId={environmentId} watches={home.watches} />
    </SettingsPageContainer>
  );
}

function HomeNotesSection({
  environmentId,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const notes = useEnvironmentQuery(serverEnvironment.homeNotes({ environmentId, input: {} }));
  const write = useAtomCommand(serverEnvironment.writeHomeNotes, { label: "home notes write" });
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<HomeFailure | null>(null);
  const baseline = saved ?? notes.data?.text ?? null;
  const value = draft ?? baseline ?? "";
  const dirty = baseline !== null && value !== baseline;
  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setFailure(null);
    const result = await write({ environmentId, input: { text: value } });
    setSaving(false);
    const failed = homeFailure(result, m);
    setFailure(failed);
    if (failed === null && result._tag === "Success") {
      setSaved(value);
      setDraft(null);
    }
  };
  return (
    <SettingsSection
      {...setting("home-notes")}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canEdit || !dirty || saving}
          onClick={() => void save()}
        >
          {saving ? gt("Saving…") : gt("Save")}
        </Button>
      }
    >
      <SettingsRow
        title={gt("notes.md")}
        description={
          failure?.message ??
          notes.error ??
          gt("What Home remembers between conversations. Home edits it too.")
        }
      >
        <div className="mt-3 pb-3.5">
          <Textarea
            aria-label={gt("Home notes")}
            rows={12}
            value={value}
            disabled={!canEdit || baseline === null}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function HomeWatchesSection({
  environmentId,
  watches,
}: {
  readonly environmentId: EnvironmentId;
  readonly watches: ReadonlyArray<HomeWatch>;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  return (
    <SettingsSection {...setting("home-watches")}>
      {watches.length === 0 ? (
        <SettingsRow
          title={gt("Nothing watched")}
          description={gt("Threads Home starts or is asked to follow show here until they settle.")}
        />
      ) : (
        watches.map((watch) => (
          <HomeWatchRow
            key={"threadId" in watch ? `thread:${watch.threadId}` : `run:${watch.workflowRunId}`}
            environmentId={environmentId}
            watch={watch}
          />
        ))
      )}
    </SettingsSection>
  );
}

function HomeWatchRow({
  environmentId,
  watch,
}: {
  readonly environmentId: EnvironmentId;
  readonly watch: HomeWatch;
}) {
  const gt = useGT();
  const m = useMessages();
  const watchEnvironmentId = watch.environmentId ?? environmentId;
  const threadRef = "threadId" in watch ? scopeThreadRef(watchEnvironmentId, watch.threadId) : null;
  const thread = useQuietThreadShell(threadRef);
  const reason = watch.reason === "launched" ? gt("Started by Home") : gt("Followed by Home");
  const nowMinute = useNowMinute();
  const added = formatRelativeTimeLabel(watch.addedAt, Date.parse(`${nowMinute}:00.000Z`), m);
  return (
    <SettingsRow
      title={
        threadRef !== null ? (
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(threadRef)}
            className="underline-offset-4 hover:underline"
          >
            {thread?.title ?? threadRef.threadId}
          </Link>
        ) : "workflowRunId" in watch ? (
          <Link
            to="/workflows"
            search={{ env: watchEnvironmentId, run: watch.workflowRunId }}
            className="underline-offset-4 hover:underline"
          >
            {gt("Workflow run {id}", { id: watch.workflowRunId })}
          </Link>
        ) : null
      }
      description={added ? `${reason} · ${added}` : reason}
    />
  );
}
