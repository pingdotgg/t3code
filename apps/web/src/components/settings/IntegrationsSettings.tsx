import { useEffect, useRef, useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinearIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { SettingsItemMark, SettingsPageContainer, SettingsSection } from "./settingsLayout";

const LINEAR_API_KEYS_URL = "https://linear.app/settings/api";
const LINEAR_API_KEY_PREFIX = "lin_api_";
const INVALID_KEY_MESSAGE = "Invalid API key or connection failed";
const MALFORMED_KEY_MESSAGE =
  "That doesn't look like a Linear personal API key (should start with lin_api_).";
const DISCONNECT_ERROR_MESSAGE = "Failed to disconnect Linear";

type PendingAction = "connect" | "disconnect" | null;

function LinearRowSkeleton() {
  return (
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
              <Skeleton className="size-4.5 rounded-md" />
              <Skeleton
                className="pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background"
                aria-hidden
              />
            </span>
            <Skeleton className="h-4 w-28 rounded-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-3 w-full max-w-xs rounded-full" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-7 w-24 rounded-md" />
        </div>
      </div>
    </div>
  );
}

function LinearIntegrationRow() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "server settings update",
  );
  const status = useEnvironmentQuery(
    environmentId === null
      ? null
      : linearEnvironment.status({
          environmentId,
          input: {},
        }),
  );

  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const latestDataRef = useRef(status.data);
  const refreshedFromRef = useRef(status.data);
  const resolveArmedRef = useRef(false);

  useEffect(() => {
    latestDataRef.current = status.data;
  }, [status.data]);

  useEffect(() => {
    // Only act on the refetch we triggered after persisting: arming happens
    // immediately before status.refresh(), so an incidental revalidation that
    // emits stale (pre-commit) data during the persist await cannot resolve the
    // pending state early and flash an error. A stale pre-arm error can't leak
    // through either: refresh marks the result waiting synchronously, so while
    // isPending is true this early-returns, and only the fresh settle resolves.
    if (pending === null || !resolveArmedRef.current || status.isPending) {
      return;
    }
    // Resolve once the refetch has settled. A completed refresh re-decodes the
    // status into a new object, so a changed identity means fresh data arrived.
    // A failed refetch keeps the previous success value (same identity) but
    // surfaces an error, so treat a non-null error as a settle too — otherwise
    // an errored refetch never changes identity and the pending state sticks.
    const settledWithError = status.error !== null;
    if (status.data === refreshedFromRef.current && !settledWithError) {
      return;
    }
    resolveArmedRef.current = false;
    const wasConnect = pending === "connect";
    setPending(null);
    if (wasConnect) {
      if (!settledWithError && status.data?.connected) {
        setApiKey("");
        setError(null);
      } else {
        setError(INVALID_KEY_MESSAGE);
      }
    }
  }, [pending, status.data, status.error, status.isPending]);

  // Once genuinely connected, no connect-flow error can still be valid; clear
  // any that a race left stranded. A failed disconnect keeps its own error,
  // which is shown in the connected row and re-set on a fresh failure.
  useEffect(() => {
    if (status.data?.connected && error !== null && error !== DISCONNECT_ERROR_MESSAGE) {
      setError(null);
    }
  }, [error, status.data]);

  if (status.isPending && status.data === null) {
    return <LinearRowSkeleton />;
  }

  const connected = status.data?.connected ?? false;
  const isBusy = pending !== null;
  const accountLabel = connected
    ? [status.data?.viewerName, status.data?.organizationName]
        .filter((value): value is string => Boolean(value))
        .join(" · ")
    : "";

  const handleConnect = async () => {
    const trimmedKey = apiKey.trim();
    if (trimmedKey.length === 0 || isBusy || environmentId === null) {
      return;
    }
    if (!trimmedKey.startsWith(LINEAR_API_KEY_PREFIX)) {
      setError(MALFORMED_KEY_MESSAGE);
      return;
    }
    setError(null);
    setPending("connect");
    const result = await persistServerSettings({
      environmentId,
      input: { patch: { linear: { apiKey: trimmedKey } } },
    });
    if (result._tag === "Failure") {
      setPending(null);
      setError(INVALID_KEY_MESSAGE);
      return;
    }
    refreshedFromRef.current = latestDataRef.current;
    resolveArmedRef.current = true;
    status.refresh();
  };

  const handleDisconnect = async () => {
    if (isBusy || environmentId === null) {
      return;
    }
    setError(null);
    setPending("disconnect");
    const result = await persistServerSettings({
      environmentId,
      input: { patch: { linear: { apiKey: "" } } },
    });
    if (result._tag === "Failure") {
      setPending(null);
      setError(DISCONNECT_ERROR_MESSAGE);
      return;
    }
    refreshedFromRef.current = latestDataRef.current;
    resolveArmedRef.current = true;
    status.refresh();
  };

  return (
    <div className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SettingsItemMark
              dotClassName={connected ? "bg-success" : "bg-warning"}
              icon={<LinearIcon className="size-4.5" aria-hidden />}
            />
            <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              Linear
            </span>
            <Badge variant={connected ? "success" : "warning"} size="sm">
              {connected ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <p className="min-w-0 text-xs text-muted-foreground/80">
            {connected
              ? accountLabel
                ? `Connected as ${accountLabel}`
                : "Attach Linear issue context to your prompts."
              : "Connect Linear to attach issue context to your prompts."}
          </p>
        </div>
        {connected ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant="destructive-outline"
              className="h-7 px-3 text-xs"
              onClick={() => void handleDisconnect()}
              disabled={isBusy}
            >
              {pending === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        ) : null}
      </div>

      {connected ? (
        error ? (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        ) : null
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="password"
              size="sm"
              className="sm:max-w-sm"
              placeholder="Personal API key"
              value={apiKey}
              disabled={isBusy}
              aria-label="Linear personal API key"
              onChange={(event) => {
                setApiKey(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleConnect();
                }
              }}
            />
            <Button
              size="sm"
              className="h-7 shrink-0 px-3 text-xs"
              onClick={() => void handleConnect()}
              disabled={isBusy || apiKey.trim().length === 0}
            >
              {pending === "connect" ? "Connecting…" : "Connect"}
            </Button>
          </div>
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <p className="text-xs text-muted-foreground/80">
              Create a personal API key at{" "}
              <a
                href={LINEAR_API_KEYS_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                linear.app/settings/api
              </a>
              .
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function IntegrationsSettings() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Integrations">
        <LinearIntegrationRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
