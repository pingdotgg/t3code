import { Component, useEffect, type ReactNode } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";

import { AppText as Text } from "./AppText";
import { MaterialButton } from "./MaterialButton";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";

interface RenderErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKeys?: ReadonlyArray<unknown>;
  readonly renderFallback?: (props: RenderFailureProps) => ReactNode;
}

interface RenderErrorBoundaryState {
  readonly failed: boolean;
  readonly error: unknown;
  readonly componentStack?: string;
  readonly resetKeys?: ReadonlyArray<unknown>;
}

export interface RenderFailureProps {
  readonly details: string;
  readonly retry: () => void;
}

function errorDetails(error: unknown, componentStack?: string): string {
  let description: string;
  try {
    description = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } catch {
    description = "Unknown render error";
  }
  return componentStack ? `${description}\nComponent stack:\n${componentStack}` : description;
}

/** A failed subtree remounts on retry or when its identifying inputs change. */
export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  override state: RenderErrorBoundaryState = {
    failed: false,
    error: null,
    resetKeys: this.props.resetKeys,
  };

  static getDerivedStateFromProps(
    { resetKeys }: RenderErrorBoundaryProps,
    state: RenderErrorBoundaryState,
  ): Partial<RenderErrorBoundaryState> | null {
    if (
      resetKeys?.length !== state.resetKeys?.length ||
      resetKeys?.some((key, index) => !Object.is(key, state.resetKeys?.[index]))
    ) {
      return { failed: false, error: null, componentStack: undefined, resetKeys };
    }
    return null;
  }

  static getDerivedStateFromError(error: unknown): Partial<RenderErrorBoundaryState> {
    return { failed: true, error };
  }

  override componentDidCatch(_error: unknown, info: { componentStack?: string }) {
    this.setState({ componentStack: info.componentStack });
  }

  private readonly retry = () => {
    this.setState({ failed: false, error: null, componentStack: undefined });
  };

  override render() {
    if (!this.state.failed) return this.props.children;
    const fallback =
      this.props.renderFallback ??
      ((props: RenderFailureProps) => <RenderFailureView {...props} />);
    return fallback({
      details: errorDetails(this.state.error, this.state.componentStack),
      retry: this.retry,
    });
  }
}

export function RenderFailureView(
  props: RenderFailureProps & {
    readonly title?: string;
    readonly bottomInset?: number;
    readonly exit?: { readonly label: string; readonly onPress: () => void };
  },
) {
  const title = props.title ?? "This screen couldn't be displayed";
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(title);
  }, [title]);

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerClassName="flex-grow items-center justify-center gap-5 px-6 py-8"
      contentContainerStyle={
        props.bottomInset ? { paddingBottom: 32 + props.bottomInset } : undefined
      }
    >
      <Text accessibilityRole="header" className="text-center text-xl font-t3-bold">
        {title}
      </Text>
      <Text className="text-center text-sm text-foreground-muted">
        Try again. If it keeps happening, copy the details for a bug report.
      </Text>
      <Text selectable className="text-center font-mono text-xs text-danger-foreground">
        {props.details.split("\n", 1)[0]?.slice(0, 300)}
      </Text>
      <View className="w-full max-w-xs gap-2">
        <MaterialButton label="Try again" onPress={props.retry} tone="primary" fullWidth />
        <MaterialButton
          label="Copy details"
          onPress={() => copyTextWithHaptic(props.details, { target: "error details" })}
          fullWidth
        />
        {props.exit ? (
          <MaterialButton
            label={props.exit.label}
            onPress={props.exit.onPress}
            tone="text"
            fullWidth
          />
        ) : null}
      </View>
    </ScrollView>
  );
}
