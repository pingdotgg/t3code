import type { MenuAction } from "@react-native-menu/menu";
import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

export interface PullRequestFilterMenu {
  readonly actions: readonly MenuAction[];
  readonly onSelect: (id: string) => void;
  /** Whether any filter, the environment, or a non-default sort is active. */
  readonly customized: boolean;
}

const MenuContext = createContext<PullRequestFilterMenu | null>(null);
const PublishContext = createContext<Dispatch<SetStateAction<PullRequestFilterMenu | null>> | null>(
  null,
);

/**
 * The Android PR header opens the full filter menu, but the facets (authors, labels) and the
 * controls live in the list below it. The list publishes its menu here; only the header reads
 * it, so the list's own renders don't fan out.
 */
export function PullRequestFilterMenuProvider(props: { readonly children: ReactNode }) {
  const [menu, setMenu] = useState<PullRequestFilterMenu | null>(null);
  return (
    <PublishContext value={setMenu}>
      <MenuContext value={menu}>{props.children}</MenuContext>
    </PublishContext>
  );
}

export function usePullRequestFilterMenu() {
  return use(MenuContext);
}

export function usePublishPullRequestFilterMenu(menu: PullRequestFilterMenu | null) {
  const publish = use(PublishContext);
  // A layout effect, so the header's filter button lands in the same frame as the list. There is
  // no cleanup: the list lives exactly as long as this provider, and a hidden tab runs its
  // cleanups, which would drop the button for a few frames every time the tab came back.
  useLayoutEffect(() => {
    if (publish && menu) publish(menu);
  }, [publish, menu]);
}
