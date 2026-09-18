import type {
  ThreadGitControls as IosThreadGitControls,
  ThreadGitMenu as IosThreadGitMenu,
  useThreadGitRightHeaderItems as useIosThreadGitRightHeaderItems,
} from "./ThreadGitControls";

export type { ThreadGitMenuProps } from "./ThreadGitControls";

type ThreadGitControlsProps = Parameters<typeof IosThreadGitControls>[0];
const EMPTY_HEADER_ITEMS: ReturnType<typeof useIosThreadGitRightHeaderItems> = [];

export function useThreadGitRightHeaderItems(_props: ThreadGitControlsProps) {
  return EMPTY_HEADER_ITEMS;
}

export function useThreadGitCenterHeaderItems(_props: ThreadGitControlsProps) {
  return EMPTY_HEADER_ITEMS;
}

export function ThreadGitControls(_props: ThreadGitControlsProps) {
  return null;
}

export function ThreadGitMenu(_props: Parameters<typeof IosThreadGitMenu>[0]) {
  return null;
}

export function useThreadGitMenuDefinition(_props: Parameters<typeof IosThreadGitMenu>[0]) {
  return null;
}
