import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand } from "~/versionSkew";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

/**
 * The npm install on the server side is capped at 10 minutes; expire the
 * spinner a bit beyond that so a dead transport never strands a disabled
 * button, while a legitimately slow install is never cut off.
 */
const UPDATE_PENDING_EXPIRY_MS = 12 * 60_000;

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

/**
 * The call-to-action for a version-skewed server, matched to the update path
 * it advertises: a one-click install-and-restart for servers that can update
 * themselves, an update-the-desktop-app hint for desktop-managed backends
 * (running `npx t3` there would start a second server, not update this one),
 * and copying the manual relaunch command for everything else — so the skew
 * warning always offers a way out.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  targetVersion,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly targetVersion: string;
}) {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const inFlightRef = useRef(false);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: "update command",
    onCopy: ({ command }) => {
      toastManager.add({
        type: "success",
        title: "Update command copied",
        description: `Run \`${command}\` on ${serverLabel} to update it.`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy update command",
        description: error.message,
      });
    },
  });

  useEffect(
    () => () => {
      if (expiryRef.current !== null) {
        clearTimeout(expiryRef.current);
        expiryRef.current = null;
      }
    },
    [],
  );

  const handleUpdate = () => {
    // Synchronous re-entry guard: setPending is async, so a rapid
    // double-click would otherwise dispatch two updates.
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setPending(true);
    const armExpiry = () => {
      const expiry = setTimeout(() => {
        expiryRef.current = null;
        inFlightRef.current = false;
        setPending(false);
        toastManager.add({
          type: "error",
          title: "Server update timed out",
          description: "The update may still be running on the server — check again in a minute.",
        });
      }, UPDATE_PENDING_EXPIRY_MS);
      expiryRef.current = expiry;
      return expiry;
    };
    let expiry = armExpiry();
    let restartAccepted = false;
    void Promise.resolve()
      .then(() =>
        updateServer({
          environmentId,
          input: { targetVersion },
        }),
      )
      .then((result) => {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: "Server update failed",
              description: updateFailureMessage(squashAtomCommandFailure(result)),
            });
          }
          return;
        }
        restartAccepted = true;
        // Installation can legitimately consume most of the request window.
        // Give restart/reconnect a fresh full window after the server accepts
        // the handoff instead of expiring based on the original click time.
        if (expiryRef.current === expiry) {
          clearTimeout(expiry);
          expiry = armExpiry();
        }
        toastManager.add({
          type: "success",
          title: `Updating ${serverLabel}`,
          description: `t3@${result.value.targetVersion} is installed — the server is restarting and will reconnect shortly.`,
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Server update failed",
          description: updateFailureMessage(error),
        });
      })
      .finally(() => {
        // A successful RPC only acknowledges that restart is scheduled. Keep
        // the action disabled until version sync unmounts it, or until the
        // safety expiry reports that reconnection never arrived.
        if (restartAccepted) return;
        if (expiryRef.current === expiry) {
          expiryRef.current = null;
        }
        clearTimeout(expiry);
        inFlightRef.current = false;
        setPending(false);
      });
  };

  if (selfUpdate === "desktop-managed") {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  if (selfUpdate === null) {
    const command = manualServerUpdateCommand(targetVersion);
    return (
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(command, { command })}>
        Copy update command
      </Button>
    );
  }

  return pending ? (
    <Button size="xs" disabled>
      <Spinner className="size-3.5" />
      Updating...
    </Button>
  ) : (
    <Button size="xs" onClick={() => void handleUpdate()}>
      Update server
    </Button>
  );
}
