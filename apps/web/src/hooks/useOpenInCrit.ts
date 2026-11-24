import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  allowsPreviewTunnel,
  AuthTerminalOperateScope,
  CritOpenError,
  type CritOpenInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { shellEnvironment } from "../state/shell";
import { useEnvironment } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { randomUUID } from "../lib/utils";
import { m } from "../i18n/messages";
import { ensureLocalApi } from "../localApi";
import { forwardPort, stopPortForward } from "../state/portForwards";
import { resolveCritForwarding } from "./useOpenInCrit.logic";

const critError = (cause: unknown) =>
  new CritOpenError({ message: cause instanceof Error ? cause.message : String(cause) });

function openForwardedReview(environmentId: EnvironmentId, port: number) {
  const owner = randomUUID();
  return Effect.acquireRelease(
    Effect.tryPromise({ try: () => forwardPort(environmentId, port, owner), catch: critError }),
    () => Effect.promise(() => stopPortForward(environmentId, port, owner)),
  ).pipe(
    Effect.flatMap((forward) =>
      Effect.tryPromise({
        try: () => ensureLocalApi().shell.openExternal(`http://127.0.0.1:${forward.localPort}/`),
        catch: critError,
      }),
    ),
  );
}

async function openCritUrl(url: string | null, remote: boolean): Promise<void> {
  if (url === null) {
    if (remote)
      throw new Error("The remote server did not forward Crit. Update the server and try again.");
    return;
  }
  await ensureLocalApi().shell.openExternal(url);
}

function reportCritError(error: unknown): void {
  toastManager.add({
    type: "error",
    title: m(msg("Could not open Crit")),
    description: error instanceof Error ? error.message : String(error),
  });
}

export function useOpenInCrit(environmentId: EnvironmentId | null): {
  open: (input: CritOpenInput) => Promise<void>;
  disabled: boolean;
} {
  const gt = useGT();
  const command = useAtomCommand(shellEnvironment.openInCrit, { reportFailure: false });
  const allowed = useAtomValue(shellEnvironment.openInCrit.permissionAtom(environmentId));
  const environment = useEnvironment(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrNull(prepared);
  const ssh = connection?.target._tag === "SshConnectionTarget";
  const canTunnel = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const disabled = !allowed || (ssh && !canTunnel);
  const [opening, setOpening] = useState(false);

  const open = async (input: CritOpenInput): Promise<void> => {
    if (environmentId === null || opening || disabled) return;
    if (ssh) {
      if (!environment?.serverConfig?.shellForwardCritReview) {
        reportCritError(gt("Update the remote T3 Code server to open Crit over SSH."));
        return;
      }
      if (!allowsPreviewTunnel(environment.serverConfig)) {
        reportCritError(gt("Enable the preview tunnel on this environment to forward the review."));
        return;
      }
    }
    setOpening(true);
    let starting = true;
    const finishOpening = () => {
      if (starting) setOpening(false);
      starting = false;
    };
    try {
      const forwarding = resolveCritForwarding(environment?.entry ?? null, connection);
      const result = await command({
        environmentId,
        input: {
          ...input,
          ...(forwarding.kind === "ssh"
            ? {
                forward: (port: number) =>
                  openForwardedReview(environmentId, port).pipe(
                    Effect.tap(() => Effect.sync(finishOpening)),
                  ),
              }
            : {}),
          ...(forwarding.kind === "tailscale" ? { tailscale: true } : {}),
        },
      });
      if (result._tag === "Success" && forwarding.kind !== "ssh") {
        await openCritUrl(result.value, forwarding.kind !== "local");
      }
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportCritError(squashAtomCommandFailure(result));
      }
    } catch (error) {
      reportCritError(error);
    }
    finishOpening();
  };

  return { open, disabled: opening || disabled };
}
