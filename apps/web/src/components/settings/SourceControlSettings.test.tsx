import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    readonly children?: ReactNode;
    readonly disabled?: boolean;
    readonly onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: ({
    "aria-label": ariaLabel,
    disabled,
    onChange,
    placeholder,
    value,
  }: {
    readonly "aria-label"?: string;
    readonly disabled?: boolean;
    readonly onChange?: (event: { target: { value: string } }) => void;
    readonly placeholder?: string;
    readonly value?: string;
  }) => (
    <input
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={onChange}
      placeholder={placeholder}
      value={value}
    />
  ),
}));

import type { GitHubAccount } from "@t3tools/contracts";

import { GitHubAccountRow } from "./SourceControlSettings";

let renderer: ReactTestRenderer | undefined;

const account: GitHubAccount = {
  label: "Work",
  host: "github.com",
  tokenConfigured: false,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function renderRow(oauthActive: boolean) {
  act(() => {
    renderer = create(
      <GitHubAccountRow
        id="work"
        account={account}
        oauthActive={oauthActive}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onSignIn={vi.fn()}
      />,
    );
  });
  return renderer!.root;
}

function button(root: ReactTestRenderer["root"], label: string) {
  return root.findAllByType("button").find((candidate) => candidate.children.includes(label));
}

describe("GitHub account OAuth editing", () => {
  it("disables metadata editing while OAuth is active but keeps removal available", () => {
    const root = renderRow(true);

    expect(root.findAllByType("input")).toHaveLength(3);
    expect(root.findAllByType("input").every((input) => input.props.disabled)).toBe(true);
    expect(button(root, "Sign in with GitHub")?.props.disabled).toBe(true);
    expect(button(root, "Save")?.props.disabled).toBe(true);
    expect(button(root, "Remove")?.props.disabled).not.toBe(true);
  });
});
