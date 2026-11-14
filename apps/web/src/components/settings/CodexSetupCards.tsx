import { AuthProvidersManageScope, ProviderDriverKind } from "@t3tools/contracts";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChatGptHandoffInput,
  ChatGptTransferredProfile,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { codexAuthHandoffUrl } from "@t3tools/shared/codexAuthHandoff";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import {
  Children,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ensureLocalApi } from "../../localApi";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { ManagedControl } from "../ManagedPolicy";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { waitForQuerySettled } from "../../state/waitForQuerySettled";
import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { ChatGptUsageButton } from "./ChatGptUsageButton";
import { ChatGptAccountPicker } from "./ChatGptAccountPicker";
import { Input } from "../ui/input";
import { OpenAI } from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";
import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";
import { getProviderSummary } from "./providerStatus";
import {
  settleAuthorizationPage,
  settleHandoffAuthorizationPage,
  settleProviderInstall,
} from "./CodexSetupSection.logic";
import { CodexSetupSection } from "./CodexSetupSectionParts";



export function CodexManagedRuntimeFields({
  environmentId,
  instanceId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
}) {
  const installation = useEnvironmentQuery(
    serverEnvironment.providerInstallState({
      environmentId,
      input: { instanceId },
    }),
  );
  const executablePath = installation.data?.executablePath ?? "";
  return (
    <>
      <SettingsRow
        title="Binary path"
        description="Selected by T3 Code."
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label="Codex binary path"
              value={executablePath}
              title={executablePath}
              placeholder={installation.error ? "Could not read runtime path" : "Not installed"}
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title="CODEX_HOME path"
        description="Shared Codex config, sessions, and state."
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label="Codex home path"
              value={provider?.runtimePaths?.homePath ?? ""}
              title={provider?.runtimePaths?.homePath}
              placeholder="Unavailable"
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title="Shadow home path"
        description={
          provider?.runtimePaths?.shadowHomePath
            ? "Account-specific home sharing the Codex state above."
            : "This instance uses the shared Codex home directly."
        }
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label="Codex shadow home path"
              value={provider?.runtimePaths?.shadowHomePath ?? ""}
              title={provider?.runtimePaths?.shadowHomePath ?? undefined}
              placeholder={provider?.runtimePaths ? "Not used" : "Unavailable"}
              disabled
            />
          </div>
        }
      />
    </>
  );
}

export function CodexSignInDescription({
  label = "Complete sign-in in your browser.",
  expanded = false,
  controls,
  onToggle,
}: {
  readonly label?: string;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly onToggle?: () => void;
}) {
  if (!onToggle) return <div className="leading-relaxed">{label}</div>;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-sm text-left leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-label="Having trouble signing in?"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {label}
      <ChevronRightIcon aria-hidden className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`} />
    </button>
  );
}

export function CodexWelcomeCard({
  title,
  description,
  control,
  secondaryControl,
  children,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly control?: ReactNode;
  readonly secondaryControl?: ReactNode;
  readonly children?: ReactNode;
}) {
  const footer = Children.toArray(children);
  return (
    <div className="rounded-lg border border-border bg-background px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <OpenAI className="size-5 shrink-0 fill-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</div>
        </div>
        {control || secondaryControl ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 has-[button]:w-full has-[button]:flex-col-reverse has-[button]:items-end sm:has-[button]:w-auto sm:has-[button]:flex-row sm:has-[button]:items-center">
            {secondaryControl}
            {control}
          </div>
        ) : null}
      </div>
      {footer.length > 0 ? (
        <div className="ml-8 mt-2 flex flex-wrap items-center gap-2">{footer}</div>
      ) : null}
    </div>
  );
}
