import { useAtom } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  patchLinearSearch,
  withLinearScope,
  type LinearScope,
  type LinearSearch,
  type LinearSearchPatch,
} from "@t3tools/client-runtime/linear/search";

import { linearFiltersAtom } from "../../state/linear";
import { linearDrillRoute, linearFiltersOf, linearSearchFor } from "./linearRoutes";

/** Session filters of the issue list, shared by every Linear screen. */
export function useLinearFilters() {
  const [filters, setFilters] = useAtom(linearFiltersAtom);
  return {
    filters,
    patch: (change: LinearSearchPatch) => setFilters(patchLinearSearch(filters, change)),
    reset: (next: LinearSearch = {}) => setFilters(next),
  };
}

/** Pushes Linear screens. A scope change drops filters that name another team's states, labels or cycles. */
export function useLinearNavigation(environmentId: string | null, current: LinearScope) {
  const navigation = useNavigation();
  const [filters, setFilters] = useAtom(linearFiltersAtom);
  return {
    openScope(scope: LinearScope) {
      if (environmentId === null) return;
      const route = linearDrillRoute(environmentId, scope);
      if (route === null) return;
      setFilters(linearFiltersOf(withLinearScope(linearSearchFor(current, filters), scope)));
      navigation.dispatch(StackActions.push(route.name, route.params));
    },
    openIssue(issueId: string) {
      if (environmentId === null) return;
      navigation.dispatch(StackActions.push("LinearIssue", { environmentId, issueId }));
    },
  };
}
