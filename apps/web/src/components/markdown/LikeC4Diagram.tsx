import type { LikeC4Model } from "@likec4/core/model";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import React, {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class LikeC4ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn("LikeC4 rendering crashed:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error);
      }
      return (
        <div className="m-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>LikeC4 Diagram Error</span>
          </div>
          <div className="whitespace-pre-wrap font-mono text-[11px]">
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface LikeC4ViewOption {
  readonly id: string;
  readonly title: string;
}

export interface LikeC4DiagramProps {
  readonly code: string;
  readonly theme: "light" | "dark";
  readonly isStreaming?: boolean;
  readonly selectedViewId?: string | null;
  readonly onViewsDiscovered?: (views: ReadonlyArray<LikeC4ViewOption>) => void;
}

export function LikeC4Diagram({
  code,
  theme,
  isStreaming = false,
  selectedViewId,
  onViewsDiscovered,
}: LikeC4DiagramProps) {
  const [model, setModel] = useState<LikeC4Model<any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [diagramComponents, setDiagramComponents] = useState<{
    LikeC4ModelProvider: React.ComponentType<{
      likec4model: LikeC4Model<any>;
      children: React.ReactNode;
    }>;
    ReactLikeC4: React.ComponentType<any>;
  } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function compile() {
      setIsLoading(true);
      try {
        const [{ fromSource }, diagramPkg] = await Promise.all([
          import("@likec4/language-services/browser"),
          import("@likec4/diagram"),
        ]);

        if (!cancelled) {
          setDiagramComponents({
            LikeC4ModelProvider: diagramPkg.LikeC4ModelProvider,
            ReactLikeC4: diagramPkg.ReactLikeC4,
          });
        }

        const likec4 = await fromSource(code);

        if (likec4.hasErrors()) {
          const errors = likec4.getErrors();
          const errorMsg =
            errors.length > 0
              ? errors.map((e) => `Line ${e.line}: ${e.message}`).join("\n")
              : "Syntax or model validation error in LikeC4 definition.";
          if (!cancelled) {
            setError(errorMsg);
            setIsLoading(false);
          }
          return;
        }

        const layoutedModel = await likec4.layoutedModel();

        if (!cancelled) {
          setModel(layoutedModel);
          setError(null);
          setIsLoading(false);

          const viewsList: LikeC4ViewOption[] = [...layoutedModel.views()].map((v) => ({
            id: v.id,
            title: v.title || v.id,
          }));
          onViewsDiscovered?.(viewsList);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setIsLoading(false);
        }
      }
    }

    void compile();

    return () => {
      cancelled = true;
    };
  }, [code, onViewsDiscovered]);

  const viewOptions = useMemo(() => {
    if (!model) return [];
    return [...model.views()].map((v) => ({
      id: v.id,
      title: v.title || v.id,
    }));
  }, [model]);

  const activeViewId = useMemo(() => {
    if (selectedViewId && viewOptions.some((v) => v.id === selectedViewId)) {
      return selectedViewId;
    }
    return viewOptions[0]?.id ?? "index";
  }, [selectedViewId, viewOptions]);

  if (typeof window === "undefined" || typeof document === "undefined") {
    return (
      <div className="flex h-72 items-center justify-center p-8 text-xs text-muted-foreground">
        <span>LikeC4 architecture diagram</span>
      </div>
    );
  }

  if (error) {
    if (isStreaming) {
      return (
        <div className="flex h-64 items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span>Compiling LikeC4 architecture diagram...</span>
        </div>
      );
    }
    return (
      <div className="m-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span>LikeC4 Compilation Error</span>
        </div>
        <div className="whitespace-pre-wrap font-mono text-[11px]">{error}</div>
      </div>
    );
  }

  if (isLoading || !model || !diagramComponents) {
    return (
      <div className="flex h-72 items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        <span>Compiling LikeC4 architecture diagram...</span>
      </div>
    );
  }

  const { LikeC4ModelProvider, ReactLikeC4 } = diagramComponents;

  return (
    <div className="relative h-[480px] min-h-[380px] w-full overflow-hidden bg-card/40">
      <LikeC4ModelProvider likec4model={model}>
        <ReactLikeC4
          viewId={activeViewId}
          colorScheme={theme === "dark" ? "dark" : "light"}
          keepAspectRatio={false}
          controls={true}
          pannable={true}
          zoomable={true}
        />
      </LikeC4ModelProvider>
    </div>
  );
}
