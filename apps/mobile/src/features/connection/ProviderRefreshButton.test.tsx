// @ts-expect-error Mobile includes the runtime for this focused static-render test but not its type package.
import { renderToStaticMarkup } from "react-dom/server";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createElement, type ReactNode } from "react";

import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { ProviderRefreshButton } from "./ProviderRefreshButton";

type PressableProps = {
  readonly accessibilityLabel?: string;
  readonly accessibilityState?: { busy?: boolean; disabled?: boolean };
  readonly children?: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly testID?: string;
};

const nativeMocks = vi.hoisted(() => ({
  alert: vi.fn(),
  lastPressableProps: undefined as PressableProps | undefined,
}));

vi.mock("react-native", () => ({
  ActivityIndicator: (props: Record<string, unknown>) =>
    createElement("activity-indicator", { "data-color": props.color, "data-size": props.size }),
  Alert: { alert: nativeMocks.alert },
  Pressable: (props: PressableProps) => {
    nativeMocks.lastPressableProps = props;
    return createElement(
      "button",
      {
        "aria-label": props.accessibilityLabel,
        className: props.className,
        "data-testid": props.testID,
        disabled: props.disabled,
      },
      props.children,
    );
  },
}));

vi.mock("../../components/AppSymbol", () => ({
  SymbolView: (props: { readonly name: string }) =>
    createElement("symbol-icon", { "data-name": props.name }),
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode; readonly className?: string }) =>
    createElement("span", { className: props.className }, props.children),
}));

vi.mock("../../lib/cn", () => ({
  cn: (...inputs: Array<string | false | undefined>) => inputs.filter(Boolean).join(" "),
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: (variable: string) => `var(${variable})`,
}));

afterEach(() => {
  nativeMocks.alert.mockClear();
  nativeMocks.lastPressableProps = undefined;
});

async function pressButton() {
  nativeMocks.lastPressableProps?.onPress?.();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProviderRefreshButton", () => {
  it("renders a labeled full-size refresh action", () => {
    const markup = renderToStaticMarkup(
      <ProviderRefreshButton onRefresh={async () => AsyncResult.success(undefined)} />,
    );

    expect(markup).toContain("Refresh providers");
    expect(markup).toContain('data-testid="refresh-providers-button"');
    expect(markup).toContain('data-name="arrow.clockwise"');
    expect(nativeMocks.lastPressableProps).toMatchObject({
      accessibilityLabel: "Refresh providers",
      accessibilityState: { busy: false, disabled: false },
      disabled: false,
    });
  });

  it("keeps the compact environment-row action icon-only", () => {
    const markup = renderToStaticMarkup(
      <ProviderRefreshButton compact onRefresh={async () => AsyncResult.success(undefined)} />,
    );

    expect(markup).not.toContain("<span");
    expect(markup).toContain('data-name="arrow.clockwise"');
    expect(nativeMocks.lastPressableProps?.className).toContain("h-[42px] w-[42px]");
  });

  it("does not alert when the refresh is interrupted", async () => {
    const interruptedRefresh = vi.fn(
      async (): Promise<AtomCommandResult<unknown, unknown>> =>
        AsyncResult.failure(Cause.interrupt("environment removed")),
    );
    renderToStaticMarkup(<ProviderRefreshButton onRefresh={interruptedRefresh} />);

    await pressButton();

    expect(interruptedRefresh).toHaveBeenCalledOnce();
    expect(nativeMocks.alert).not.toHaveBeenCalled();
  });

  it("reports successful and failed refresh commands", async () => {
    const successfulRefresh = vi.fn(
      async (): Promise<AtomCommandResult<unknown, unknown>> => AsyncResult.success(undefined),
    );
    renderToStaticMarkup(<ProviderRefreshButton onRefresh={successfulRefresh} />);

    await pressButton();

    expect(successfulRefresh).toHaveBeenCalledOnce();
    expect(nativeMocks.alert).toHaveBeenCalledWith(
      "Providers refreshed",
      "Provider availability and model metadata are up to date.",
    );

    nativeMocks.alert.mockClear();
    const failedRefresh = vi.fn(
      async (): Promise<AtomCommandResult<unknown, unknown>> =>
        AsyncResult.failure(Cause.fail(new Error("provider unavailable"))),
    );
    renderToStaticMarkup(<ProviderRefreshButton onRefresh={failedRefresh} />);

    await pressButton();

    expect(failedRefresh).toHaveBeenCalledOnce();
    expect(nativeMocks.alert).toHaveBeenCalledWith(
      "Could not refresh providers",
      "provider unavailable",
    );
  });
});
