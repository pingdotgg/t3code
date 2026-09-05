import { useAtomValue } from "@effect/atom-react";
import { environmentPresentationSettlingKey } from "@t3tools/client-runtime/state/presentation";
import {
  collectResetCreditExpiryWarnings,
  resetCreditExpiryNotificationKey,
  RESET_CREDIT_REMINDER_SETTLE_GRACE_MS,
  RESET_CREDIT_REMINDER_STABILIZE_MS,
  resetCreditExpiryWarningView,
} from "@t3tools/shared/usageLimits";
import * as Linking from "expo-linking";
import { useEffect, useMemo, useState } from "react";
import { Alert, AppState } from "react-native";

import { environmentPresentations } from "../../state/presentation";

const DRIVER_LABEL: Partial<Record<string, string>> = { codex: "Codex", claudeAgent: "Claude" };
const seenNotificationKeys = new Set<string>();
type ExpiryWarnings = ReturnType<typeof collectResetCreditExpiryWarnings>;

/** Native counterpart to the web reminder; it never invokes credit redemption. */
export function ResetCreditExpiryAlert() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);

  const warnings = useMemo(
    () => collectResetCreditExpiryWarnings(presentations, now),
    [now, presentations],
  );
  const notificationKey = resetCreditExpiryNotificationKey(warnings);
  const settlingKey = useMemo(
    () => environmentPresentationSettlingKey(presentations),
    [presentations],
  );
  const isAnyEnvironmentSettling = settlingKey !== null;

  return (
    <ResetCreditExpiryAlertCycle
      key={settlingKey === null ? "settled" : `settling:${settlingKey}`}
      isAnyEnvironmentSettling={isAnyEnvironmentSettling}
      notificationKey={notificationKey}
      warnings={warnings}
    />
  );
}

function ResetCreditExpiryAlertCycle({
  isAnyEnvironmentSettling,
  notificationKey,
  warnings,
}: {
  readonly isAnyEnvironmentSettling: boolean;
  readonly notificationKey: string | null;
  readonly warnings: ExpiryWarnings;
}) {
  const [settleGraceElapsed, setSettleGraceElapsed] = useState(false);

  useEffect(() => {
    if (!isAnyEnvironmentSettling) return;
    const timer = setTimeout(
      () => setSettleGraceElapsed(true),
      RESET_CREDIT_REMINDER_SETTLE_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [isAnyEnvironmentSettling]);
  const isGated = isAnyEnvironmentSettling && !settleGraceElapsed;

  useEffect(() => {
    if (!notificationKey || isGated || seenNotificationKeys.has(notificationKey)) return;
    const timer = setTimeout(() => {
      if (seenNotificationKeys.has(notificationKey)) return;
      const view = resetCreditExpiryWarningView(warnings, (driver) => DRIVER_LABEL[driver]);
      if (view === null) return;
      seenNotificationKeys.add(notificationKey);
      Alert.alert(view.title, view.description, [
        { text: "Later", style: "cancel" },
        {
          text: "View limits",
          onPress: () => void Linking.openURL(Linking.createURL("/settings/usage?section=limits")),
        },
      ]);
    }, RESET_CREDIT_REMINDER_STABILIZE_MS);
    return () => clearTimeout(timer);
  }, [isGated, notificationKey, warnings]);
  return null;
}
