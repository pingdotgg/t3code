import { EnvironmentId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SourceControlAccountSettings } from "./SourceControlAccountSettings";

it("announces the account only while its name is revealed", async () => {
  const definition = sourceControlClients.find("github");
  if (!definition?.credentials) throw new Error("GitHub credentials are required for this test");
  const account = "demo-user";
  const label = "Toggle source control account visibility";
  await using screen = await render(
    <AppAtomRegistryProvider>
      <SourceControlAccountSettings
        environmentId={EnvironmentId.make("account-visibility-test")}
        definition={definition}
        credentials={definition.credentials}
        auth={{
          status: "authenticated",
          account: Option.some(account),
          host: Option.some("github.com"),
          detail: Option.none(),
          accounts: [{ host: "github.com", account, active: true, authenticated: true }],
        }}
        onSaved={vi.fn()}
      />
    </AppAtomRegistryProvider>,
  );
  const toggle = screen.getByRole("button", { name: label, exact: true });
  await expect.element(toggle).toHaveAccessibleName(label);
  await userEvent.click(toggle);

  const revealed = screen.getByRole("button", { pressed: true }).last();
  await expect.element(revealed).toHaveAccessibleName(`${label}: ${account}`);
  await userEvent.click(revealed);

  await expect.element(toggle).toHaveAccessibleName(label);
  await expect.element(toggle).not.toHaveTextContent(account);
});
