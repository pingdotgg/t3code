import type { MenuAction } from "@react-native-menu/menu";
import {
  createContext,
  use,
  useEffect,
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
  useEffect(() => {
    if (!publish || !menu) return;
    publish(menu);
    return () => publish((current) => (current === menu ? null : current));
  }, [publish, menu]);
}
