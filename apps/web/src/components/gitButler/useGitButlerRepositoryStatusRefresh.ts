import { useEffect, useRef } from "react";

export function useGitButlerRepositoryStatusRefresh(input: {
  readonly repositoryStatus: object | null;
  readonly refresh: () => void;
}): void {
  const { refresh, repositoryStatus } = input;
  const previousStatusRef = useRef(repositoryStatus);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = repositoryStatus;
    if (
      previousStatus !== null &&
      repositoryStatus !== null &&
      previousStatus !== repositoryStatus
    ) {
      refresh();
    }
  }, [refresh, repositoryStatus]);
}
