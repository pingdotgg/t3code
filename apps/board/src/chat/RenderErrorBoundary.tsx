import { Component, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  /** The fallback gives way to the children again when any of these changes. */
  readonly resetKeys?: ReadonlyArray<unknown>;
}

interface State {
  readonly failed: boolean;
  readonly resetKeys: ReadonlyArray<unknown> | undefined;
}

/** Shows `fallback` in place of a piece that throws while it renders, such as a diagram that fails to parse. */
export class RenderErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKeys: this.props.resetKeys };

  static getDerivedStateFromProps({ resetKeys }: Props, state: State): Partial<State> | null {
    const changed =
      resetKeys?.length !== state.resetKeys?.length ||
      resetKeys?.some((key, index) => !Object.is(key, state.resetKeys?.[index]));
    return changed ? { failed: false, resetKeys } : null;
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
