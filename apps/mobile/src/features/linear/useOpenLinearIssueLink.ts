import { StackActions, useNavigation } from "@react-navigation/native";
import { resolveLinearIssueLinkIdentifier } from "@t3tools/client-runtime/linear/issue-link";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { linearEnvironment, linearEnvironmentIdAtom } from "../../state/linear";

/** Opens a link to an issue of the connected Linear workspace in the app; false for any other link. */
export function useOpenLinearIssueLink() {
  const navigation = useNavigation();
  return (url: string): boolean => {
    // Read at press time so a status push does not hand every link a new handler.
    const environmentId = appAtomRegistry.get(linearEnvironmentIdAtom);
    if (environmentId === null) return false;
    const status = AsyncResult.getOrElse(
      appAtomRegistry.get(linearEnvironment.status({ environmentId, input: {} })),
      () => null,
    );
    const issueId = resolveLinearIssueLinkIdentifier(url, status);
    if (issueId === null) return false;
    navigation.dispatch(StackActions.push("LinearIssue", { environmentId, issueId }));
    return true;
  };
}
