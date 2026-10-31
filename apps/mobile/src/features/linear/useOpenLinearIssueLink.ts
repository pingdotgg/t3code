import { StackActions, useNavigation } from "@react-navigation/native";
import { resolveLinearIssueLinkIdentifier } from "@t3tools/client-runtime/linear/issue-link";

import { appAtomRegistry } from "../../state/atom-registry";
import { linearEnvironmentIdAtom, linearStatusAtom } from "../../state/linear";

/** Opens a link to an issue of the connected Linear workspace in the app; false for any other link. */
export function useOpenLinearIssueLink() {
  const navigation = useNavigation();
  return (url: string): boolean => {
    // Read at press time so a status push does not hand every link a new handler.
    const environmentId = appAtomRegistry.get(linearEnvironmentIdAtom);
    if (environmentId === null) return false;
    const issueId = resolveLinearIssueLinkIdentifier(url, appAtomRegistry.get(linearStatusAtom));
    if (issueId === null) return false;
    navigation.dispatch(StackActions.push("LinearIssue", { environmentId, issueId }));
    return true;
  };
}
