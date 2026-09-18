export interface FilesBrowserHeaderProps {
  readonly projectName: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onBack: () => void;
}

export interface FileHeaderProps {
  readonly title: string;
  readonly subtitle: string;
  readonly iconColor: string;
  readonly activeMode: string;
  readonly fileInspectorSupported: boolean;
  readonly onBack: () => void;
  readonly onReturnToThread: () => void;
  readonly actions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly inline: boolean;
    readonly onPress: () => unknown;
  }>;
}
