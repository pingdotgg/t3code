import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayConfigureScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export const AUTH_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthGrantScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: msg("View environment"),
    description: msg("Read threads, status, checkpoints, and configuration."),
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: msg("Operate tasks"),
    description: msg("Start, update, and stop tasks."),
  },
  {
    scope: AuthSettingsWriteScope,
    title: msg("Change environment settings"),
    description: msg("Edit environment preferences and keybindings."),
  },
  {
    scope: AuthProvidersManageScope,
    title: msg("Manage providers"),
    description: msg("Configure, install, sign in to, and update providers and usage sources."),
  },
  {
    scope: AuthEnvironmentMaintainScope,
    title: msg("Maintain environment"),
    description: msg("Update the server and control environment processes."),
  },
  {
    scope: AuthPreviewOperateScope,
    title: msg("Control previews"),
    description: msg("Open browser previews and host browser automation."),
  },
  {
    scope: AuthDiagnosticsReadScope,
    title: msg("View diagnostics and usage"),
    description: msg("Read process diagnostics, resource history, and usage totals."),
  },
  {
    scope: AuthTerminalReadScope,
    title: msg("View terminals"),
    description: msg("Read existing terminal output and status."),
  },
  {
    scope: AuthTerminalOperateScope,
    title: msg("Use terminals"),
    description: msg("Create terminals and send input to running shells."),
  },
  {
    scope: AuthSourceControlWriteScope,
    title: msg("Change source control"),
    description: msg("Commit, push, manage branches and repositories, and change pull requests."),
  },
  {
    scope: AuthFilesystemReadScope,
    title: msg("Read files"),
    description: msg("Browse host files, search workspaces, and inspect local changes."),
  },
  {
    scope: AuthFilesystemWriteScope,
    title: msg("Write files"),
    description: msg("Edit workspace files and save plans to disk."),
  },
  {
    scope: AuthAccessReadScope,
    title: msg("View access"),
    description: msg("Inspect pairing links and authorized clients."),
  },
  {
    scope: AuthAccessWriteScope,
    title: msg("Manage access"),
    description: msg("Issue and revoke credentials for other clients."),
  },
  {
    scope: AuthRelayReadScope,
    title: msg("View relay"),
    description: msg("Inspect managed relay connectivity."),
  },
  {
    scope: AuthRelayWriteScope,
    title: msg("Manage relay"),
    description: msg("Update relay preferences or unlink T3 Connect."),
  },
  {
    scope: AuthRelayConfigureScope,
    title: msg("Configure relay (admin)"),
    description: msg(
      "Set up or replace T3 Connect, including its trusted pairing credential issuer.",
    ),
  },
];

/** Shown instead of the granted scopes while they are unknown, so every surface says the same thing. */
export function sessionPermissionsUnavailableMessage(
  input: {
    readonly connected: boolean;
    /** The check errored; the client retries it while connected. */
    readonly failed: boolean;
    /** The environment answered that this session is not signed in; retrying will not change that. */
    readonly rejected: boolean;
  },
  resolve: MFunctionType = mFallback,
): string {
  if (!input.connected)
    return resolve(msg("Connect to this environment to view this session’s permissions."));
  if (input.rejected)
    return resolve(msg("This environment did not accept your session. Reconnect to try again."));
  return input.failed
    ? resolve(msg("Could not verify your permissions. Retrying automatically."))
    : resolve(msg("Checking permissions…"));
}
