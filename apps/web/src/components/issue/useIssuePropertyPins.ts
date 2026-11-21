import {
  IssuePropertyPins,
  issuePropertyPinKey,
  toggleIssuePropertyPin,
} from "@t3tools/client-runtime/issue-properties";
import type { IssueDetail } from "@t3tools/contracts";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const NO_PINS: IssuePropertyPins = {};

/** The fields pinned to one issue's summary on this device. */
export function useIssuePropertyPins(issue: IssueDetail) {
  const [pins, setPins] = useLocalStorage("t3.issues.propertyPins", NO_PINS, IssuePropertyPins);
  const key = issuePropertyPinKey(issue);
  return {
    ids: pins[key] ?? [],
    toggle: (propertyId: string) =>
      setPins((current) => toggleIssuePropertyPin(current, key, propertyId)),
  };
}
