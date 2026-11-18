import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: state.query }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));

import { InferenceProviderAccounts } from "./InferenceProviderAccounts";
import { serverEnvironment } from "../../state/server";

const host = EnvironmentId.make("account-host");
const workAccountName = "codex-work@example.com.json";
function setup() {
  state.run.mockReset();
  state.query.mockReset().mockReturnValue({
    data: {
      enabled: true,
      accounts: [
        {
          name: workAccountName,
          provider: "codex",
          status: "error",
          availability: "rateLimited",
          retryAfter: "2099-01-01T00:00:00Z",
        },
        {
          name: "expired.json",
          provider: "codex",
          status: "error",
          availability: "authenticationError",
        },
        { name: "personal.json", provider: "claude", status: "active", availability: "available" },
      ],
    },
  });
}

describe("inference provider accounts", () => {
  it("adds an account through the inference host and completes its callback without creating a profile", async () => {
    setup();
    const reconnect = vi.fn();
    using _permission = vi
      .spyOn(serverEnvironment.inferenceProxy.manageInference, "permissionAtom")
      .mockReturnValue(Atom.make(true));
    state.run.mockResolvedValue({ _tag: "Success", value: { status: "ok" } });
    state.run.mockResolvedValueOnce({
      _tag: "Success",
      value: { login: { url: "https://provider.example/sign-in", state: "proxy-login" } },
    });
    await using screen = await render(
      <InferenceProviderAccounts
        environmentId={host}
        driver="codex"
        onAccountsChanged={reconnect}
      />,
    );
    const accountNames = screen.getByRole("button", { name: "Toggle account name visibility" });
    expect(accountNames.all()).toHaveLength(2);
    const workAccount = accountNames.first();
    await expect.element(screen.getByText(workAccountName)).not.toBeInTheDocument();
    await userEvent.click(workAccount);
    await expect.element(screen.getByText(workAccountName)).toBeVisible();
    await userEvent.click(workAccount);
    await expect.element(screen.getByText(workAccountName)).not.toBeInTheDocument();
    await expect.element(screen.getByText("codex · Rate limited")).toBeVisible();
    await expect
      .element(screen.getByText("codex · Authentication or access rejected"))
      .toBeVisible();
    await expect.element(screen.getByText(/Retry after/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Codex", exact: true }));
    expect(state.run).toHaveBeenLastCalledWith({
      environmentId: host,
      input: { operation: "signIn", upstream: "codex" },
    });
    await expect
      .element(screen.getByRole("link", { name: "Open sign-in" }))
      .toHaveAttribute("href", "https://provider.example/sign-in");
    await userEvent.fill(
      screen.getByLabelText("Sign-in callback URL"),
      "http://localhost/callback?code=done",
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit", exact: true }));
    expect(state.run).toHaveBeenLastCalledWith({
      environmentId: host,
      input: {
        operation: "callback",
        state: "proxy-login",
        callback: "http://localhost/callback?code=done",
      },
    });
    await expect.element(screen.getByRole("button", { name: "Codex", exact: true })).toBeVisible();
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("can start hosting on the selected environment during provider setup", async () => {
    setup();
    using _permission = vi
      .spyOn(serverEnvironment.inferenceProxy.manageInference, "permissionAtom")
      .mockReturnValue(Atom.make(true));
    using config = vi
      .spyOn(serverEnvironment, "configValueAtom")
      .mockReturnValue(
        Atom.make({ environment: { capabilities: { inferenceConfigureGuard: false } } }) as never,
      );
    state.query.mockReturnValue({ data: { enabled: false } });
    state.run.mockResolvedValueOnce({ _tag: "Success", value: {} });
    const reconnect = vi.fn();
    const setupAccounts = () => (
      <InferenceProviderAccounts
        environmentId={host}
        driver="codex"
        enableLocalHosting
        onAccountsChanged={reconnect}
      />
    );
    await using screen = await render(setupAccounts());
    await expect
      .element(screen.getByRole("link", { name: "Inference accounts" }))
      .toHaveAttribute("href", "/settings/inference?machine=account-host");
    await expect
      .element(screen.getByRole("button", { name: "Start hosting here" }))
      .not.toBeInTheDocument();
    await screen.unmount();
    config.mockReturnValue(
      Atom.make({ environment: { capabilities: { inferenceConfigureGuard: true } } }) as never,
    );
    await using supportedScreen = await render(setupAccounts());
    await userEvent.click(supportedScreen.getByRole("button", { name: "Start hosting here" }));
    expect(state.run).toHaveBeenCalledWith({
      environmentId: host,
      input: { operation: "configure", enabled: true, sharing: false, expectedEnabled: false },
    });
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("does not reconnect after leaving a pending account setup", async () => {
    setup();
    using _permission = vi
      .spyOn(serverEnvironment.inferenceProxy.manageInference, "permissionAtom")
      .mockReturnValue(Atom.make(true));
    let finish: () => void = () => {};
    state.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ _tag: "Success", value: { status: "ok" } });
        }),
    );
    const reconnect = vi.fn();
    await using screen = await render(
      <InferenceProviderAccounts
        environmentId={host}
        driver="codex"
        onAccountsChanged={reconnect}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Codex", exact: true }));
    expect(state.run).toHaveBeenCalledOnce();
    await screen.unmount();
    await act(async () => finish());
    expect(reconnect).not.toHaveBeenCalled();
  });
});
