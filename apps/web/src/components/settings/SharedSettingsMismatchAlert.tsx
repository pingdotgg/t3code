import { TriangleAlertIcon } from "lucide-react";
import {
  formatSharedServerSettingValue,
  sharedServerSettingLabels,
} from "@t3tools/client-runtime/state/shared-settings";

import { useSharedSettingsSync } from "../../hooks/useSettings";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

/**
 * Warns when a connected environment holds different shared settings than
 * the primary one, and offers to write the primary's values everywhere.
 * Renders nothing when every connected environment agrees.
 */
export function SharedSettingsMismatchAlert() {
  const { mismatches, applyToAll, sourceLabel } = useSharedSettingsSync();
  if (mismatches.length === 0) {
    return null;
  }
  const labels = mismatches.map((mismatch) => mismatch.label).join(", ");
  return (
    <Alert variant="warning" controlAlignment="first-line" className="mx-3 sm:mx-4">
      <TriangleAlertIcon />
      <AlertDescription>
        <p>Settings differ on {labels}.</p>
        <details className="min-w-0">
          <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
            Review differences
          </summary>
          <div className="mt-3 space-y-3 rounded-lg bg-card p-3 text-foreground">
            <p className="break-words">
              Apply to all copies shared preferences from <strong>{sourceLabel}</strong> (primary)
              to the environments below. Only changed values are listed.
            </p>
            {mismatches.map((mismatch) => (
              <section key={mismatch.environmentId} className="min-w-0 border-t border-border pt-3">
                <h3 className="break-words font-medium">{mismatch.label}</h3>
                <dl className="mt-2 space-y-3">
                  {mismatch.differences.map(({ key, currentValue, incomingValue }) => (
                    <div key={key}>
                      <dt className="font-medium">{sharedServerSettingLabels[key]}</dt>
                      <dd className="mt-1 grid min-w-0 gap-2 sm:grid-cols-2">
                        <div>
                          <span className="font-medium">Current</span>
                          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                            {formatSharedServerSettingValue(key, currentValue)}
                          </p>
                        </div>
                        <div>
                          <span className="font-medium">From {sourceLabel} (primary)</span>
                          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                            {formatSharedServerSettingValue(key, incomingValue)}
                          </p>
                        </div>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            <Button variant="outline" size="xs" onClick={applyToAll}>
              Apply to all
            </Button>
          </div>
        </details>
      </AlertDescription>
    </Alert>
  );
}
