import {
  getEnvironmentSpeechCloudModels,
  removeEnvironmentSpeechCloudKey,
  saveEnvironmentSpeechCloudKey,
  selectEnvironmentSpeechCloudModel,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentSpeechCloudModel, EnvironmentSpeechStatus } from "@t3tools/contracts";
import {
  CheckIcon,
  ExternalLinkIcon,
  InfoIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { ensureLocalApi } from "../../localApi";
import { runtime } from "../../lib/runtime";
import { speechCloudFailureMessage } from "../../speech/speechErrors";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { formatSpeechCloudPrice } from "./speechCloudPricing";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";

type SupportedStatus = Extract<EnvironmentSpeechStatus, { supported: true }>;

function errorDescription(error: unknown) {
  return (
    speechCloudFailureMessage(error, "settings") ??
    (error instanceof Error ? error.message : String(error))
  );
}

function CloudModelRow(props: {
  readonly model: EnvironmentSpeechCloudModel;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: () => void;
}) {
  const { model } = props;
  const price = formatSpeechCloudPrice(model.pricing);
  return (
    <SettingsRow
      title={model.name}
      description={model.id}
      status={
        price ? (
          <Text variant="meta" tone="muted" numeric>
            {price}
          </Text>
        ) : undefined
      }
      control={
        <div className="flex shrink-0 items-center gap-1">
          {model.description ? (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`Details for ${model.name}`}
                  />
                }
              >
                <InfoIcon className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent align="end" width="md">
                <p className="text-label">{model.name}</p>
                <p className="mt-1.5 text-meta text-muted-foreground">{model.description}</p>
              </PopoverContent>
            </Popover>
          ) : null}
          {props.selected ? (
            <Button size="sm" variant="secondary" disabled>
              <CheckIcon className="size-3.5" />
              Selected
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={props.busy} onClick={props.onSelect}>
              Use model
            </Button>
          )}
        </div>
      }
    />
  );
}

/** OpenRouter's side of the transcription models: the API key, then its live model list. */
export function VoiceCloudSettings(props: {
  readonly prepared: PreparedConnection;
  readonly status: SupportedStatus;
  readonly onStatus: (status: EnvironmentSpeechStatus) => void;
}) {
  const { prepared, status } = props;
  const keyConfigured = status.cloud?.keyConfigured === true;
  const selectedId = status.engine === "openrouter" ? status.cloud?.modelId : undefined;
  const [keyDraft, setKeyDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{
    readonly prepared: PreparedConnection;
    readonly models: readonly EnvironmentSpeechCloudModel[] | null;
    readonly failed: boolean;
  } | null>(null);
  const [modelSearch, setModelSearch] = useState("");

  const loadCatalog = useStableCallback((connection: PreparedConnection) => {
    setCatalog({ prepared: connection, models: null, failed: false });
    void runtime
      .runPromise(getEnvironmentSpeechCloudModels(connection))
      .then(({ models }) => setCatalog({ prepared: connection, models, failed: false }))
      .catch(() => setCatalog({ prepared: connection, models: null, failed: true }));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch OpenRouter's live catalog from the environment once a key is saved.
  useEffect(() => {
    if (keyConfigured) loadCatalog(prepared);
  }, [keyConfigured, prepared, loadCatalog]);

  const run = (operation: string, work: () => Promise<EnvironmentSpeechStatus>, title: string) => {
    setPending(operation);
    return work()
      .then((next) => {
        props.onStatus(next);
        return true;
      })
      .catch((error) => {
        toastManager.add({ type: "error", title, description: errorDescription(error) });
        return false;
      })
      .finally(() => setPending(null));
  };

  const saveKey = () => {
    const apiKey = keyDraft.trim();
    if (!apiKey || pending) return;
    void run(
      "key",
      () => runtime.runPromise(saveEnvironmentSpeechCloudKey(prepared, apiKey)),
      "Could not save the OpenRouter key",
    ).then((saved) => {
      if (saved) setKeyDraft("");
    });
  };

  const deleteKey = () =>
    void ensureLocalApi()
      .dialogs.confirm(
        "Delete the OpenRouter API key from this environment? Voice input goes back to local models.",
      )
      .then((confirmed) => {
        if (confirmed)
          void run(
            "key",
            () => runtime.runPromise(removeEnvironmentSpeechCloudKey(prepared)),
            "Could not delete the OpenRouter key",
          );
      });

  const currentCatalog = catalog?.prepared === prepared ? catalog : null;
  const searchTerm = modelSearch.trim().toLocaleLowerCase();
  const models = (currentCatalog?.models ?? [])
    .filter(
      (model) =>
        !searchTerm || `${model.name} ${model.id}`.toLocaleLowerCase().includes(searchTerm),
    )
    // The selected model leads, like the local list; the rest keep the environment's order.
    .sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));

  return (
    <>
      <SettingsRow
        title="OpenRouter API key"
        description={
          keyConfigured ? (
            <>
              Saved on this environment, ending in{" "}
              <span className="font-mono">{status.cloud?.keyHint}</span>. Recordings are sent to
              OpenRouter and the model's provider.
            </>
          ) : (
            "Transcribe with OpenRouter's models. Recordings are sent to OpenRouter and the model's provider."
          )
        }
        control={
          keyConfigured ? (
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={pending !== null}
              onClick={deleteKey}
            >
              <Trash2Icon className="size-3.5" />
              Delete key
            </Button>
          ) : (
            <form
              className="flex w-full max-w-80 items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                saveKey();
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-or-…"
                aria-label="OpenRouter API key"
                value={keyDraft}
                maxLength={512}
                disabled={pending !== null}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={pending !== null || !keyDraft.trim()}>
                {pending === "key" ? "Checking…" : "Save"}
              </Button>
            </form>
          )
        }
      >
        {keyConfigured ? null : (
          <div className="pb-1">
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void ensureLocalApi().shell.openExternal(OPENROUTER_KEYS_URL)}
            >
              <KeyRoundIcon className="size-3.5" />
              Create a key on OpenRouter
              <ExternalLinkIcon className="size-3" />
            </Button>
          </div>
        )}
      </SettingsRow>
      {keyConfigured ? (
        <>
          <SettingsRow
            title="Search models"
            control={
              <div className="flex w-full max-w-80 items-center gap-1">
                <Input
                  type="search"
                  size="compact"
                  aria-label="Search OpenRouter models"
                  placeholder="Search models"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                />
                {modelSearch ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Clear model search"
                    onClick={() => setModelSearch("")}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            }
          />
          {currentCatalog?.failed ? (
            <SettingsRow
              title="Couldn't load OpenRouter's models"
              description="Check this environment's connection to openrouter.ai."
              control={
                <Button size="sm" variant="secondary" onClick={() => loadCatalog(prepared)}>
                  <RefreshCwIcon className="size-3.5" />
                  Retry
                </Button>
              }
            />
          ) : !currentCatalog?.models ? (
            <SettingsRow title="Loading OpenRouter models…" />
          ) : models.length === 0 ? (
            <SettingsRow title="No models match your search." />
          ) : (
            models.map((model) => (
              <CloudModelRow
                key={model.id}
                model={model}
                selected={model.id === selectedId}
                busy={pending !== null}
                onSelect={() =>
                  void run(
                    model.id,
                    () => runtime.runPromise(selectEnvironmentSpeechCloudModel(prepared, model.id)),
                    "Could not select the model",
                  )
                }
              />
            ))
          )}
        </>
      ) : null}
    </>
  );
}
