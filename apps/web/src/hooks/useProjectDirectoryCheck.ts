import { useCallback, useEffect, useRef } from "react";
import { WS_METHODS } from "@t3tools/contracts";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";

const CHECK_DEBOUNCE_MS = 500;

export function useProjectDirectoryCheck(): void {
  const projects = useStore((s) => s.projects);
  const setMissingProjectCwds = useStore((s) => s.setMissingProjectCwds);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkDirectories = useCallback(async () => {
    const api = readNativeApi();
    if (!api || projects.length === 0) return;

    const cwds = projects.map((p) => p.cwd);
    try {
      const result = await api.request(WS_METHODS.checkProjectDirectories, { cwds });
      const missing: string[] = (result as { missing: string[] }).missing ?? [];
      setMissingProjectCwds(new Set(missing));
    } catch {
      // If the check itself fails, don't block the UI
    }
  }, [projects, setMissingProjectCwds]);

  // Check on mount and when projects change
  useEffect(() => {
    void checkDirectories();
  }, [checkDirectories]);

  // Check on window focus (debounced)
  useEffect(() => {
    const onFocus = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void checkDirectories();
      }, CHECK_DEBOUNCE_MS);
    };

    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [checkDirectories]);
}
