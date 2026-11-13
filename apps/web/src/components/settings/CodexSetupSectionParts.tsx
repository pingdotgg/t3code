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
import type { CodexSetupSectionProps } from "./CodexSetupSection";
import { CodexSignInDescription, CodexWelcomeCard, ManagedCodexSetup } from "./CodexSetupSection";

export function CodexSetupSection(props: CodexSetupSectionProps) {
  const [requested, setRequested] = useState(false);
  // A policy that owns Codex's launch settings also rules out ChatGPT's own runtime.
  const codexLocks = managedInstanceLocks(
    useManagedPolicy(props.environmentId),
    ProviderDriverKind.make("codex"),
  );
  const chatGptDenial = codexLocks?.configKeys.has("setupMode") ? codexLocks.reason : undefined;
  const existingState = getOnboardingProviderState(props.provider);
  const existingReady = props.enabled && existingState === "ready";
  const existingAuthenticated = props.provider?.auth.status === "authenticated";
  const existingChecking = existingState === "checking";
  const existingSummary = getProviderSummary(props.provider);
  const content =
    props.mode === "existing" && props.presentation === "onboarding" ? (
      <CodexWelcomeCard
        title={props.displayName || props.provider?.displayName || "Codex"}
        description={
          existingReady ? (
            props.provider?.auth.email?.trim() ? (
              <>
                Signed in as{" "}
                <RedactedSensitiveText
                  value={props.provider.auth.email.trim()}
                  ariaLabel="Toggle account email visibility"
                  revealTooltip="Click to reveal email"
                  hideTooltip="Click to hide email"
                  className="break-all"
                />
                .
              </>
            ) : (
              "Connected with your Codex CLI."
            )
          ) : existingChecking ? (
            "Checking your Codex CLI..."
          ) : props.provider?.installed ? (
            existingSummary.headline
          ) : (
            "Code with your ChatGPT subscription."
          )
        }
        control={
          existingReady ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              Ready
            </span>
          ) : existingChecking ? (
            <span className="text-xs text-muted-foreground">Checking...</span>
          ) : existingAuthenticated ? (
            <span className="text-xs text-muted-foreground">{existingSummary.headline}</span>
          ) : (
            <ManagedControl reason={chatGptDenial}>
              <ChatGptConnectionButton
                size="sm"
                disabled={props.readOnly}
                onClick={() => {
                  setRequested(true);
                  props.onModeChange("managed");
                }}
              >
                Continue with ChatGPT
              </ChatGptConnectionButton>
            </ManagedControl>
          )
        }
        secondaryControl={
          !existingAuthenticated && !existingReady && !existingChecking ? (
            <Button size="sm" variant="ghost-muted" onClick={() => props.onModeChange("existing")}>
              Use existing CLI
            </Button>
          ) : null
        }
      />
    ) : props.mode === "existing" ? null : !props.provider?.setup?.canAuthenticate ? (
      props.presentation === "onboarding" ? (
        <CodexWelcomeCard
          title={props.displayName || props.provider?.displayName || "Codex"}
          description={<CodexSignInDescription />}
          control={
            <Button size="sm" variant="outline" className="min-w-44" disabled>
              Open sign-in page
            </Button>
          }
          secondaryControl={
            <Button size="sm" variant="ghost-muted" disabled>
              Cancel
            </Button>
          }
        />
      ) : (
        <SettingsRow title="ChatGPT account" description="Preparing sign-in." />
      )
    ) : (
      <ManagedCodexSetup
        key={`${props.environmentId}:${props.instanceId}`}
        {...props}
        autoStart={requested || props.autoStart === true}
        onAutoStartConsumed={() => {
          setRequested(false);
          props.onAutoStartConsumed?.();
        }}
      />
    );
  return content;
}

