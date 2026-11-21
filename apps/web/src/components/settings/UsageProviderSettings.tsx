import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UnifiedSettings, UsageLimitSourceSnapshot } from "@lathe/contracts";
import { T, useGT, Var } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PROXY_NAME = "CLI Proxy";

type SourceKind = "cliproxy" | "modelproxy";

/** Source management follows the selected device and access rules of provider settings. */
export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const snapshots = serverConfig?.usageLimitSources ?? [];
  const kindName = (kind: SourceKind) =>
    kind === "cliproxy" ? CLI_PROXY_NAME : gt("modelproxy gateway");
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add source</T>
            </Button>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title={gt("No hubs configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            const snapshot = snapshots.find((candidate) => candidate.id === id);
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {source.enabled
                      ? kindName(source.kind)
                      : gt("{name} · Disabled", { name: kindName(source.kind) })}
                    {label !== source.url ? ` · ${source.url}` : ""}
                    {source.kind === "modelproxy" ? (
                      <GatewayAuthStatus snapshot={snapshot} />
                    ) : null}
                  </span>
                }
                control={
                  !readOnly ? (
                    <span className="flex items-center gap-1">
                      {source.kind === "modelproxy" ? (
                        <GatewayAuthButton
                          environmentId={environmentId}
                          sourceId={id}
                          snapshot={snapshot}
                        />
                      ) : null}
                      <RemoveUsageProviderButton
                        label={label}
                        kind={source.kind}
                        onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                      />
                    </span>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function GatewayAuthStatus({
  snapshot,
}: {
  readonly snapshot: UsageLimitSourceSnapshot | undefined;
}) {
  const auth = snapshot?.proxy?.auth;
  if (!auth) return null;
  if (auth.state === "signedIn") {
    return (
      <>
        {" · "}
        <T>Signed in</T>
      </>
    );
  }
  if (auth.state === "pending") {
    return (
      <>
        {" · "}
        <T>
          Confirm device code{" "}
          <code className="font-mono tracking-widest">
            <Var>{auth.userCode}</Var>
          </code>{" "}
          at{" "}
          <a
            className="underline"
            href={auth.verificationUrlComplete ?? auth.verificationUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Var>{auth.verificationUrl}</Var>
          </a>
          , then sign in with your password and a passkey or authenticator code. This row updates
          when you finish.
        </T>
      </>
    );
  }
  return (
    <>
      {" · "}
      <T>Not signed in</T>
    </>
  );
}

function GatewayAuthButton({
  environmentId,
  sourceId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: string;
  readonly snapshot: UsageLimitSourceSnapshot | undefined;
}) {
  const auth = useAtomCommand(serverEnvironment.usageLimitSourceAuth);
  const state = snapshot?.proxy?.auth.state ?? "signedOut";
  const action = state === "signedIn" ? "signOut" : state === "pending" ? "cancel" : "start";
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => void auth({ environmentId, input: { sourceId: sourceId as never, action } })}
    >
      {state === "signedIn" ? (
        <T>Sign out</T>
      ) : state === "pending" ? (
        <T>Cancel sign-in</T>
      ) : (
        <T>Sign in</T>
      )}
    </Button>
  );
}

/** Removing a source deletes its stored secret, so it requires confirmation. */
function RemoveUsageProviderButton({
  label,
  kind,
  onConfirm,
}: {
  readonly label: string;
  readonly kind: SourceKind;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {kind === "cliproxy" ? (
                <T>
                  The hub's management key is deleted from this server. Its accounts leave the
                  Limits view; the hub itself is untouched. Add it again with the URL and key to
                  bring them back.
                </T>
              ) : (
                <T>
                  The gateway's client secret and your sign-in session are deleted from this server.
                  Its accounts leave the Limits view; the gateway itself is untouched. Add it again
                  to bring them back.
                </T>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {kind === "cliproxy" ? <T>Remove hub</T> : <T>Remove gateway</T>}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
