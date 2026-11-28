import { resetCreditFailureText } from "@t3tools/client-runtime/state/usage";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderConsumeResetCreditInput,
  type ProviderConsumeResetCreditOutcome,
} from "@t3tools/contracts";
import type { ResetCreditChoice } from "@t3tools/shared/usageLimits";
import { msg } from "gt-react-native";
import { useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

const DEFAULT_CONFIRM_DESCRIPTION = msg(
  "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
);

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: msg("Reset applied. Your windows have cleared."),
  nothingToReset: msg("Nothing to reset right now."),
  noCredit: msg("No reset credit left."),
  alreadyRedeemed: msg("That credit was already redeemed."),
};

/** Spending a credit asks for confirmation first because it cannot be undone. */
export function useResetCredit(
  environmentId: EnvironmentId,
  input: ProviderConsumeResetCreditInput,
) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, {
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async (creditInput: ProviderConsumeResetCreditInput) => {
    if (inFlight.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    inFlight.current = true;
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input: creditInput }).catch(() => null);
    inFlight.current = false;
    setBusy(false);
    if (result?._tag === "Success") {
      setStatus(result.value.warning ?? m(OUTCOME_TEXT[result.value.outcome]));
      return;
    }
    setStatus(
      result === null
        ? m(msg("Could not use the reset credit."))
        : resetCreditFailureText(result, m),
    );
  };

  /** Without a choice, redeems the next credit for the hook's `input`. */
  const confirm = (choice?: Pick<ResetCreditChoice, "input" | "confirmDescription">) => {
    if (inFlight.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    Dialog.alert(
      m(msg("Use a reset credit?")),
      choice?.confirmDescription ?? m(DEFAULT_CONFIRM_DESCRIPTION),
      [
        { text: m(msg("Cancel")), style: "cancel" },
        { text: m(msg("Use credit")), onPress: () => void redeem(choice?.input ?? input) },
      ],
    );
  };

  return { canManageProviders, busy, status, confirm };
}
