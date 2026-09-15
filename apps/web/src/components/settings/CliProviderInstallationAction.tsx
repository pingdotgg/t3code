import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstallationControls } from "./ProviderInstallationControls";
import { ArrowUpCircleIcon, DownloadIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function CliProviderInstallationAction(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly providerName: string;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  if (props.readOnly || !props.provider?.setup?.canInstall) return null;
  return <CliProviderInstallationActions {...props} provider={props.provider} />;
}

function CliProviderInstallationActions({
  environmentId,
  environmentLabel,
  instanceId,
  providerName,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly providerName: string;
  readonly provider: ServerProvider;
}) {
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderInstall, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderInstall, options);
  const remove = useAtomCommand(serverEnvironment.removeProviderInstallation, options);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<A, E>(request: () => Promise<AtomCommandResult<A, E>>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Installation failed. Try again.");
      }
    } catch {
      setError("Installation failed. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  const installation = query.data;
  const installed = provider.installed || installation?.installedVersion != null;
  const message =
    installation?.phase === "downloading" && installation.totalBytes
      ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)} of ${(installation.totalBytes / 1_000_000).toFixed(1)} MB.`
      : (installation?.message ?? (installed ? "Installed." : "Not installed."));
  if (provider.installed && provider.status !== "disabled" && !installation?.canRemove) return null;
  const active =
    installation && ["downloading", "extracting", "verifying"].includes(installation.phase);
  const label = active ? "Installing" : installation?.installedVersion ? "Update" : "Install";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={`${label} ${providerName} — view details`}
          >
            {installed ? <ArrowUpCircleIcon /> : <DownloadIcon />}
            {label}
          </Button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
      >
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <p className="text-[13px] font-semibold leading-tight text-foreground">
              {providerName} installation
            </p>
            <p className="text-xs leading-snug text-muted-foreground">
              Installs on {environmentLabel}. Sign in separately after installation.
            </p>
          </div>
          <ProviderInstallationControls
            compact
            tracksReleases
            providerName={providerName}
            installation={installation}
            installed={installed}
            usesCustomBinary={false}
            canInstall={provider.setup?.canInstall === true}
            disabled={pending || query.error !== null}
            installationStatusMessage={message}
            onInstall={() => void run(() => start(target))}
            onCancel={(operationId) =>
              void run(() => cancel({ environmentId, input: { instanceId, operationId } }))
            }
            onRemove={() =>
              void (async () => {
                const confirmed = await ensureLocalApi().dialogs.confirm(
                  `Remove the downloaded ${providerName} runtime from ${environmentLabel}? Disable its instances first. Credentials and thread history are kept.`,
                );
                if (confirmed) await run(() => remove(target));
              })()
            }
          />
          {error || query.error ? (
            <p role="alert" className="text-xs text-destructive">
              {error ?? "Could not read installation status. Reconnect and try again."}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
