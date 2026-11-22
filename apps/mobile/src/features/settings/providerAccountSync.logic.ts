import {
  type AccountSyncBlockReason,
  type AccountSyncEnvironment,
  planProviderAccountSync,
  type ProviderAccountSyncCell,
  providerAccountSyncFailureMessage,
  syncedAccountState,
} from "@t3tools/client-runtime/state/provider-account-sync";
import type {
  EnvironmentId,
  ProviderAccountOmission,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";

export function blockNote(
  reason: AccountSyncBlockReason,
  device: string,
  resolve: MessageResolver = m,
): string {
  switch (reason) {
    case "same-environment":
      return resolve(msg("This is the source device."));
    case "not-connected":
      return resolve(msg("{device} isn't connected.", { device }));
    case "update-required":
      return resolve(msg("Update {device} to sync accounts.", { device }));
    case "permission-required":
      return resolve(msg("This connection can't manage providers on {device}.", { device }));
    case "instance-id-conflict":
      return resolve(msg("{device} uses this account's ID for another provider.", { device }));
  }
}

export interface SyncDestinationChoice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly disabled: boolean;
  readonly note: string | null;
}

export function syncDestinationChoice(
  input: {
    readonly source: AccountSyncEnvironment;
    readonly destination: AccountSyncEnvironment;
    readonly instanceId: ProviderInstanceId;
  },
  resolve: MessageResolver = m,
): SyncDestinationChoice {
  const { source, destination, instanceId } = input;
  const plan = planProviderAccountSync({
    source,
    destinations: [destination],
    instanceIds: [instanceId],
  });
  const { environmentId, label } = destination;
  const cell = plan.cells[0];
  const block = plan.destinations[0]?.block ?? null;
  if (block !== null)
    return { environmentId, label, disabled: true, note: blockNote(block, label, resolve) };
  if (plan.sourceBlock !== null)
    return {
      environmentId,
      label,
      disabled: true,
      note: blockNote(plan.sourceBlock, source.label, resolve),
    };
  if (cell?.action === "blocked")
    return { environmentId, label, disabled: true, note: blockNote(cell.reason, label, resolve) };
  if (cell?.action === "update")
    return {
      environmentId,
      label,
      disabled: false,
      note: cell.signedInAs
        ? resolve(
            msg("Updates the copy on {device} (signed in as {account}).", {
              device: label,
              account: cell.signedInAs,
            }),
          )
        : resolve(msg("Updates the copy on {device}.", { device: label })),
    };
  return { environmentId, label, disabled: false, note: null };
}

function omittedNote(
  omitted: ReadonlyArray<ProviderAccountOmission>,
  sourceLabel: string,
  destinationLabel: string,
  resolve: MessageResolver,
): string | null {
  const names = (reason: ProviderAccountOmission["reason"]) =>
    omitted
      .filter((omission) => omission.reason === reason)
      .map(({ setting }) => (setting._tag === "ConfigField" ? setting.field : setting.name));
  const parts: Array<string> = [];
  const local = names("machine-local");
  if (local.length > 0)
    parts.push(
      resolve(
        msg("Stays on {source}: {settings}.", { source: sourceLabel, settings: local.join(", ") }),
      ),
    );
  const unsupported = names("unsupported-here");
  if (unsupported.length > 0)
    parts.push(
      resolve(
        msg("Not supported on {destination}, update it: {settings}.", {
          destination: destinationLabel,
          settings: unsupported.join(", "),
        }),
      ),
    );
  const missing = names("missing-on-source");
  if (missing.length > 0)
    parts.push(
      resolve(
        msg("No value on {source}: {settings}.", {
          source: sourceLabel,
          settings: missing.join(", "),
        }),
      ),
    );
  const oversized = names("too-large");
  if (oversized.length > 0)
    parts.push(resolve(msg("Too large to copy: {settings}.", { settings: oversized.join(", ") })));
  return parts.length === 0 ? null : parts.join(" ");
}

export interface SyncResultRow {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly tone: "default" | "danger";
}

export function syncResultRow(
  input: {
    readonly cell: ProviderAccountSyncCell;
    readonly accountLabel: string;
    readonly sourceLabel: string;
    readonly destinationLabel: string;
    /** The copy as the destination reports it; undefined until the destination lists it. */
    readonly destinationProvider: Parameters<typeof syncedAccountState>[0];
  },
  resolve: MessageResolver = m,
): SyncResultRow {
  const { cell, accountLabel, sourceLabel, destinationLabel } = input;
  const key = `${cell.instanceId}:${cell.destinationEnvironmentId}`;
  const title = resolve(
    msg("{account} on {destination}", { account: accountLabel, destination: destinationLabel }),
  );
  if (cell.status === "skipped") {
    const device = cell.end === "source" ? sourceLabel : destinationLabel;
    return { key, title, description: blockNote(cell.reason, device, resolve), tone: "default" };
  }
  if (cell.status === "failed") {
    return {
      key,
      title,
      description: providerAccountSyncFailureMessage(cell, resolve),
      tone: "danger",
    };
  }
  const state = syncedAccountState(input.destinationProvider);
  const status = (() => {
    switch (state.kind) {
      case "ready":
        return state.signedInAs
          ? resolve(msg("Ready, signed in as {account}.", { account: state.signedInAs }))
          : resolve(msg("Ready."));
      case "starting":
        return resolve(msg("Starting on {destination}.", { destination: destinationLabel }));
      case "disabled":
        return resolve(msg("Turned off on {destination}.", { destination: destinationLabel }));
      case "error":
        return state.message
          ? resolve(
              msg("Problem on {destination}: {message}", {
                destination: destinationLabel,
                message: state.message,
              }),
            )
          : resolve(msg("Problem on {destination}.", { destination: destinationLabel }));
      case "needs-sign-in":
        return resolve(
          msg("Sign in on {destination} to finish.", { destination: destinationLabel }),
        );
      case "needs-host-setup":
        return resolve(
          msg("Sign in on {destination} with the provider's own tool.", {
            destination: destinationLabel,
          }),
        );
    }
  })();
  const note = omittedNote(cell.omitted, sourceLabel, destinationLabel, resolve);
  return {
    key,
    title,
    description: note === null ? status : `${status} ${note}`,
    tone: state.kind === "error" ? "danger" : "default",
  };
}
