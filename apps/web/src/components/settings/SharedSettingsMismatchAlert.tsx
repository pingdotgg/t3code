import { TriangleAlertIcon } from "lucide-react";

import { useSharedSettingsSync } from "../../hooks/useSettings";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

/**
 * Warns when a connected environment holds different shared settings than
 * the primary one, and offers to write the primary's values everywhere.
 * Renders nothing when every connected environment agrees.
 */
export function SharedSettingsMismatchAlert() {
  const { mismatches, applyToAll } = useSharedSettingsSync();
  if (mismatches.length === 0) {
    return null;
  }
  const labels = mismatches.map((mismatch) => mismatch.label).join(", ");
  return (
    <Alert variant="warning" className="mx-3 sm:mx-4">
      <TriangleAlertIcon />
      <AlertDescription>
        Settings differ on {labels}. Thread and source control preferences are meant to match on
        every environment.
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="xs" onClick={applyToAll}>
          Apply to all
        </Button>
      </AlertAction>
    </Alert>
  );
}
