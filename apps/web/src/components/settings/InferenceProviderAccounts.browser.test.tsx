import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

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
    using _permission = vi
      .spyOn(serverEnvironment.inferenceProxy.manageInference, "permissionAtom")
      .mockReturnValue(Atom.make(true));
    state.run.mockResolvedValue({ _tag: "Success", value: { status: "ok" } });
    state.run.mockResolvedValueOnce({
      _tag: "Success",
      value: { login: { url: "https://provider.example/sign-in", state: "proxy-login" } },
    });
    await using screen = await render(
      <InferenceProviderAccounts environmentId={host} driver="codex" />,
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
  });
});
