import {
  EnvironmentId,
  type KeybindingRule,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { RegistryProvider } from "@effect/atom-react";
import type { ReactNode } from "react";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { KeybindingCommandControl } from "./KeybindingsSettings";
import { useSettingsScope, useOptionalSettingsScope } from "./SettingsScopeContext";

vi.mock(import("../../state/session"), { spy: true });
vi.mock(import("../../state/use-atom-command"), { spy: true });
vi.mock(import("./SettingsScopeContext"), { spy: true });

function setup(rules: readonly (readonly KeybindingRule[] | null)[] = [[]]) {
  const environments = rules.map((bindings, index) => ({
    environmentId: EnvironmentId.make(`dictation-${index}`),
    label: `Environment ${index}`,
    serverConfig:
      bindings === null
        ? null
        : {
            keybindings: compileResolvedKeybindingsConfig(bindings),
            keybindingsConfigPath: null,
            availableEditors: [],
          },
  }));
  const scope = {
    environment: environments[0] ?? null,
    connectedEnvironments: environments,
  } as unknown as NonNullable<ReturnType<typeof useOptionalSettingsScope>>;
  vi.mocked(useOptionalSettingsScope).mockReturnValue(scope);
  vi.mocked(useSettingsScope).mockReturnValue(scope);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentsWithScope).mockReturnValue(
    new Set(environments.map((environment) => environment.environmentId)),
  );
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  const save = vi
    .fn<
      (input: {
        environmentId: EnvironmentId;
        input: ServerUpsertKeybindingInput;
      }) => Promise<AsyncResult.Success<void> | AsyncResult.Failure<void, Error>>
    >()
    .mockResolvedValue(AsyncResult.success(undefined));
  vi.mocked(useAtomCommand).mockReturnValue(save as ReturnType<typeof useAtomCommand>);
  return { environments, save, scope };
}

function Control({ children }: { children: ReactNode }) {
  return (
    <RegistryProvider>
      <>
        <KeybindingCommandControl command="composer.dictation" />
        {children}
      </>
    </RegistryProvider>
  );
}

const dictation: KeybindingRule = {
  command: "composer.dictation",
  key: "mod+alt+d",
  when: "!terminalFocus",
};
const editName = /^Edit shortcut for Composer: Start or Finish Dictation:/;
const recorded = /Mac/i.test(navigator.platform) ? "{Meta>}k{/Meta}" : "{Control>}k{/Control}";

it("replaces the saved rule on each selected environment and keeps its condition", async () => {
  const { environments, save, scope } = setup([[dictation], [dictation]]);
  await using screen = await render(<KeybindingCommandControl command="composer.dictation" />);
  await screen.getByRole("button", { name: editName }).click();
  await userEvent.keyboard(recorded);
  await expect
    .element(screen.getByLabelText("Conflicts with Command Palette: Toggle."))
    .toBeVisible();
  expect(save).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls.map(([input]) => input)).toEqual(
    environments.map((environment) => ({
      environmentId: environment.environmentId,
      input: { command: dictation.command, key: "mod+k", when: dictation.when, replace: dictation },
    })),
  );
  vi.mocked(useOptionalSettingsScope).mockReturnValue({
    ...scope,
    connectedEnvironments: scope.connectedEnvironments.map((environment) => ({
      ...environment,
      serverConfig: {
        ...environment.serverConfig!,
        keybindings: compileResolvedKeybindingsConfig([{ ...dictation, key: "mod+k" }]),
      },
    })),
  });
  await screen.rerender(<KeybindingCommandControl command="composer.dictation" />);
  await expect
    .element(
      screen.getByRole("button", {
        name: /Edit shortcut for Composer: Start or Finish Dictation: (Ctrl\+K|⌘K)/,
      }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Save", exact: true }))
    .not.toBeInTheDocument();
});

it("discards an inline shortcut draft on Escape without changing the saved binding", async () => {
  const { save } = setup([[dictation]]);
  await using screen = await render(<Control>{null}</Control>);
  await screen.getByRole("button", { name: editName }).click();
  await userEvent.keyboard(recorded);
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: editName })).toHaveFocus();
  await expect
    .element(screen.getByRole("button", { name: "Save", exact: true }))
    .not.toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

it.each([
  { name: "Mixed shortcuts", rules: [[dictation], [{ ...dictation, key: "mod+alt+v" }]] },
  { name: "Multiple shortcuts", rules: [[dictation, { ...dictation, key: "mod+alt+v" }]] },
  { name: "Unloaded settings", rules: [[], null] },
])("opens detailed editing for $name", async ({ rules }) => {
  const { save } = setup(rules);
  await using screen = await render(<Control>{null}</Control>);
  await expect
    .element(screen.getByRole("link", { name: "Edit in Keybindings" }))
    .toHaveAttribute("href", "/settings/keybindings#keybinding-composer.dictation");
  expect(save).not.toHaveBeenCalled();
});

it("blocks editing without settings permission and rechecks permission when saving", async () => {
  const { save } = setup();
  vi.mocked(useEnvironmentsWithScope).mockReturnValue(new Set());
  await using screen = await render(
    <Control>
      <button>Recording mode</button>
    </Control>,
  );
  expect(screen.container.querySelector("[inert]")).not.toBeNull();
  await expect.element(screen.getByRole("button", { name: "Recording mode" })).toBeEnabled();
  vi.mocked(useEnvironmentsWithScope).mockReturnValue(new Set([EnvironmentId.make("dictation-0")]));
  await screen.rerender(<Control key="allowed">{null}</Control>);
  await screen.getByRole("button", { name: editName }).click();
  await userEvent.keyboard(recorded);
  vi.mocked(readEnvironmentScope).mockReturnValue(false);
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  expect(save).not.toHaveBeenCalled();
});

it("keeps the draft available after a failed save", async () => {
  const { save } = setup();
  save.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Disconnected"))));
  await using screen = await render(<Control>{null}</Control>);
  using notification = vi.spyOn(toastManager, "add");
  await screen.getByRole("button", { name: editName }).click();
  await userEvent.keyboard(recorded);
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(notification).toHaveBeenCalledOnce());
  expect(notification).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Unable to save keybinding", type: "error" }),
  );
  await expect
    .element(
      screen.getByRole("textbox", { name: "Keybinding for Composer: Start or Finish Dictation" }),
    )
    .toHaveValue("mod+k");
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});
