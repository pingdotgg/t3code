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
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "@t3tools/contracts";

export const AUTH_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthGrantScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "View environment",
    description: "Read threads, status, checkpoints, and configuration.",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "Operate tasks",
    description: "Start, update, and stop tasks.",
  },
  {
    scope: AuthSettingsWriteScope,
    title: "Change environment settings",
    description: "Edit environment preferences and keybindings.",
  },
  {
    scope: AuthProvidersManageScope,
    title: "Manage providers",
    description: "Configure, install, sign in to, and update providers and usage sources.",
  },
  {
    scope: AuthEnvironmentMaintainScope,
    title: "Maintain environment",
    description: "Update the server and control environment processes.",
  },
  {
    scope: AuthPreviewOperateScope,
    title: "Control previews",
    description: "Open browser previews and host browser automation.",
  },
  {
    scope: AuthDiagnosticsReadScope,
    title: "View diagnostics and usage",
    description: "Read process diagnostics, resource history, and usage totals.",
  },
  {
    scope: AuthTerminalReadScope,
    title: "View terminals",
    description: "Read existing terminal output and status.",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "Use terminals",
    description: "Create terminals and send input to running shells.",
  },
  {
    scope: AuthSourceControlWriteScope,
    title: "Change source control",
    description: "Commit, push, manage branches and repositories, and change pull requests.",
  },
  {
    scope: AuthFilesystemReadScope,
    title: "Read files",
    description: "Browse host files, search workspaces, and inspect local changes.",
  },
  {
    scope: AuthFilesystemWriteScope,
    title: "Write files",
    description: "Edit workspace files and save plans to disk.",
  },
  {
    scope: AuthAccessReadScope,
    title: "View access",
    description: "Inspect pairing links and authorized clients.",
  },
  {
    scope: AuthAccessWriteScope,
    title: "Manage access",
    description: "Issue and revoke credentials for other clients.",
  },
  {
    scope: AuthRelayReadScope,
    title: "View relay",
    description: "Inspect managed relay connectivity.",
  },
  {
    scope: AuthRelayWriteScope,
    title: "Manage relay",
    description: "Change managed tunnel connectivity.",
  },
];
