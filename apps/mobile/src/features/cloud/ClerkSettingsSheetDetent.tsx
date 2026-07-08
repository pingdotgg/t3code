import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface ClerkSettingsSheetDetentValue {
  collapse: () => void;
  expand: () => void;
  isExpanded: boolean;
}

const ClerkSettingsSheetDetentContext = createContext<ClerkSettingsSheetDetentValue | null>(null);

interface ClerkSettingsSheetDetentProviderProps extends PropsWithChildren {
  initiallyExpanded: boolean;
}

export function ClerkSettingsSheetDetentProvider({
  children,
  initiallyExpanded,
}: ClerkSettingsSheetDetentProviderProps) {
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded);
  const collapse = useCallback(() => setIsExpanded(false), []);
  const expand = useCallback(() => setIsExpanded(true), []);
  const value = useMemo(() => ({ collapse, expand, isExpanded }), [collapse, expand, isExpanded]);

  return (
    <ClerkSettingsSheetDetentContext value={value}>{children}</ClerkSettingsSheetDetentContext>
  );
}

export function useClerkSettingsSheetDetent(): ClerkSettingsSheetDetentValue {
  const value = useContext(ClerkSettingsSheetDetentContext);
  if (!value) {
    throw new Error(
      "useClerkSettingsSheetDetent must be used inside ClerkSettingsSheetDetentProvider",
    );
  }
  return value;
}
