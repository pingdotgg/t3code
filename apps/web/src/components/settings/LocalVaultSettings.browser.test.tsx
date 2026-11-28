import "~/index.css";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  VAULT_SERVICE_LABELS,
  VAULT_TOKEN_SERVICES,
  type VaultTokenService,
  type LocalVaultEntry,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { LocalVaultSettings } from "./LocalVaultSettings";
import type * as LocalApi from "../../localApi";
import type * as Session from "../../state/session";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  permission: null as unknown,
  openExternal: vi.fn(),
  readPreparedConnection: vi.fn(),
  gmailAvailable: undefined as boolean | undefined,
  credentialServices: undefined as readonly ("gmail" | VaultTokenService)[] | undefined,
  gmailUserCredentials: undefined as boolean | undefined,
  gmailRedirectUri: undefined as string | undefined,
  refresh: vi.fn(),
  entries: [] as LocalVaultEntry[],
  saved: [] as Array<Record<string, unknown>>,
  fail: false,
  configured: true,
  owner: true,
}));
vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof LocalApi>()),
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof Session>()),
  usePreparedConnection: (id: EnvironmentId) =>
    Option.fromNullishOr(state.readPreparedConnection(id)),
  readPreparedConnection: state.readPreparedConnection,
}));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      localVault: (() => ({})) as never,
      manageLocalVault: { permissionAtom: () => state.permission } as never,
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      entries: state.entries,
      gmailAvailable: state.gmailAvailable,
      credentialServices: state.credentialServices,
      gmailUserCredentials: state.gmailUserCredentials,
      gmailRedirectUri: state.gmailRedirectUri,
      names: state.entries.map((e) => e.name),
      error: null,
      security: { configured: state.configured, canSetInitialPin: state.owner, retryAt: 0 },
    },
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
}));
const environmentId = EnvironmentId.make("test-vault");
const PIN = "8472951";
async function setup() {
  await page.viewport(1280, 900);
  state.permission = Atom.make(true);
  state.entries = [];
  state.saved = [];
  state.fail = false;
  state.configured = true;
  state.owner = true;
  state.gmailAvailable = undefined;
  state.credentialServices = undefined;
  state.gmailUserCredentials = undefined;
  state.gmailRedirectUri = undefined;
  state.openExternal.mockReset();
  state.readPreparedConnection.mockReset();
  setRoute("PrimaryConnectionTarget", localOrigin);
  state.run.mockReset();
  state.run.mockImplementation(async (payload) => {
    if (payload.input.action === "set-pin") state.configured = true;
    if (payload.input.action === "save")
      state.saved.push(JSON.parse(Redacted.value(payload.input.value)));
    return AsyncResult.success({
      names: [],
      entries: [],
      error: state.fail ? "Vault temporarily unavailable" : null,
    });
  });
}
it("adds a structured website login with protected fields and an exact website", async () => {
  await setup();
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Add credential", exact: true }).click();
  await page.getByRole("button", { name: "Website login", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("GitHub personal");
  await page.getByRole("textbox", { name: "Website", exact: true }).fill("https://github.com");
  await page
    .getByRole("textbox", { name: "Username or email", exact: true })
    .fill("dummy@example.test");
  await page.getByLabelText("Password", { exact: true }).fill("dummy-private-password");
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Add vault entry", exact: true }))
    .not.toBeInTheDocument();
  expect(state.saved).toEqual([
    {
      version: 1,
      kind: "login",
      title: "GitHub personal",
      origin: "https://github.com",
      username: "dummy@example.test",
      password: "dummy-private-password",
    },
  ]);
});
it("edits metadata without fetching or revealing saved protected fields", async () => {
  await setup();
  state.entries = [
    {
      name: "work",
      title: "GitHub work",
      kind: "login",
      fields: ["username", "password"],
      origin: "https://github.com",
    },
  ];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Edit GitHub work", exact: true }).click();
  await expect.element(page.getByLabelText("Password", { exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed login");
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect(state.saved).toEqual([
    {
      version: 1,
      kind: "login",
      title: "Renamed login",
      origin: "https://github.com",
      username: "",
      password: "",
    },
  ]);
});
it("clears protected fields on failure and presents a usable retry", async () => {
  await setup();
  state.fail = true;
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Add credential", exact: true }).click();
  await page.getByRole("button", { name: "API token", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Work token");
  await page.getByLabelText("Token", { exact: true }).fill("dummy-api-token");
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect.element(page.getByLabelText("Token", { exact: true })).toHaveValue("");
  await expect
    .element(page.getByRole("dialog", { name: "Add vault entry", exact: true }).getByRole("alert"))
    .toHaveTextContent(
      "Vault temporarily unavailable Protected fields were cleared. Re-enter your changes before retrying.",
    );
  await expect
    .element(page.getByRole("button", { name: "Save entry", exact: true }))
    .toBeDisabled();
});
it("keeps an oversized note editable instead of sending or clearing it", async () => {
  await setup();
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Add credential", exact: true }).click();
  await page.getByRole("button", { name: "Secure note", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Long note");
  const note = "\\".repeat(9000);
  await page.getByRole("textbox", { name: "Note", exact: true }).fill(note);
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Add vault entry", exact: true }).getByRole("alert"))
    .toHaveTextContent(
      "This entry is too large. Shorten the note or credential fields before saving.",
    );
  await expect.element(page.getByRole("textbox", { name: "Note", exact: true })).toHaveValue(note);
  expect(state.run).not.toHaveBeenCalled();
});
it("requires initial PIN setup before entry creation", async () => {
  await setup();
  state.configured = false;
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Add credential", exact: true }))
    .toBeDisabled();
  await screen.getByRole("button", { name: "Set PIN", exact: true }).click();
  await page.getByLabelText("New PIN", { exact: true }).fill(PIN);
  await page.getByLabelText("Confirm new PIN", { exact: true }).fill(PIN);
  await page
    .getByRole("dialog", { name: "Set vault PIN", exact: true })
    .getByRole("button", { name: "Set PIN", exact: true })
    .click();
  await expect
    .element(screen.getByRole("button", { name: "Add credential", exact: true }))
    .toBeEnabled();
  expect(state.run.mock.calls[0]?.[0].input.action).toBe("set-pin");
});
it("does not let a paired non-owner bootstrap a PIN", async () => {
  await setup();
  state.configured = false;
  state.owner = false;
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await expect.element(screen.getByRole("button", { name: "Set PIN", exact: true })).toBeDisabled();
});
it("does not submit an entry without a PIN confirmation", async () => {
  await setup();
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Add credential", exact: true }).click();
  await page.getByRole("button", { name: "API token", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Work token");
  await page.getByLabelText("Token", { exact: true }).fill("dummy-new-token");
  await expect
    .element(page.getByRole("button", { name: "Save entry", exact: true }))
    .toBeDisabled();
  expect(state.run).not.toHaveBeenCalled();
});
it("disables entry creation on unencrypted environments", async () => {
  await setup();
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted={false} legacy />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Add credential", exact: true }))
    .toBeDisabled();
});

const localOrigin = "http://127.0.0.1:13773";
const remoteOrigin = "https://hyakki.example.org";
const callbackPath = "/oauth/gmail/callback";
const googleEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const clientId = "123456789-demo.apps.googleusercontent.com";
const consentFor = (redirect: string) =>
  `${googleEndpoint}?${new URLSearchParams({ state: "test-only", redirect_uri: redirect, client_id: clientId })}`;
const googleConsent = consentFor(localOrigin + callbackPath);
function savedMailbox(redirectUri = localOrigin + callbackPath): LocalVaultEntry {
  return {
    name: "mail",
    title: "Personal mail",
    kind: "gmail",
    fields: [],
    gmailClient: { clientId, redirectUri },
  };
}

async function fillGoogleClient() {
  const dialog = gmailDialog();
  await dialog.getByLabelText("Client ID", { exact: true }).fill(clientId);
  await dialog.getByLabelText("Client secret", { exact: true }).fill("synthetic-client-secret");
  await dialog.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
}
const invalidConsent = "The environment did not return a valid Google consent link.";
const unreachableCallback =
  "Google cannot return to this environment from this device. Configure a reachable HTTPS callback for this server, or finish setup on the server itself.";
const gmailDialog = () => page.getByRole("dialog", { name: "Credential connection", exact: true });

async function expectGmailStartRejection(message: string) {
  const dialog = gmailDialog();
  const alert = dialog.getByRole("alert");
  await expect.element(alert).not.toBeInTheDocument();
  await dialog.getByRole("button", { name: "Continue to Google", exact: true }).click();
  await expect.element(alert).toHaveTextContent(message);
  await expect.element(dialog.getByLabelText("Vault PIN", { exact: true })).not.toBeInTheDocument();
}

function setRoute(kind: ConnectionTarget["_tag"], origin: string) {
  state.readPreparedConnection.mockImplementation((id) =>
    id === environmentId
      ? {
          environmentId,
          descriptor: { environmentId },
          target: { _tag: kind, environmentId },
          httpBaseUrl: origin,
          socketUrl: `${origin.replace(/^http/u, "ws")}/ws`,
          httpAuthorization: { _tag: "Bearer", token: "private-test-token" },
        }
      : null,
  );
}
const readOnlyAccount = "example@example.test";
function enableGmail(url = googleConsent) {
  state.gmailAvailable = true;
  state.gmailUserCredentials = true;
  state.gmailRedirectUri = localOrigin + callbackPath;
  let start: { name: string; title: string } | undefined;
  state.run.mockImplementation(async ({ input }) => {
    const result = { error: null, entries: state.entries, names: state.entries.map((e) => e.name) };
    switch (input.action) {
      case "gmail-configure": {
        if (state.fail)
          return AsyncResult.success({ ...result, error: "Could not configure client" });
        if (Redacted.value(input.pin) !== PIN) throw new Error("Wrong configure PIN");
        const existing = state.entries.find((entry) => entry.name === input.name);
        if (
          input.clientSecret
            ? Redacted.value(input.clientSecret) !== "synthetic-client-secret"
            : existing?.gmailClient?.clientId !== input.clientId
        )
          throw new Error("Missing matching secret");
        const entry: LocalVaultEntry = {
          ...(existing ?? { name: input.name, title: input.title, kind: "gmail", fields: [] }),
          gmailClient: { clientId: input.clientId, redirectUri: input.redirectUri },
        };
        state.entries = [...state.entries.filter((e) => e.name !== entry.name), entry];
        break;
      }
      case "gmail-start":
        start = { name: input.name, title: input.title };
        return AsyncResult.success({
          ...result,
          gmailAuthorization: { url, flowId: "test-flow" },
        });
      case "gmail-finish": {
        if (state.fail)
          return AsyncResult.success({ ...result, error: "Google consent is not complete." });
        if (
          !start ||
          input.flowId !== "test-flow" ||
          input.name !== start.name ||
          Redacted.value(input.pin) !== PIN
        )
          throw new Error("Wrong target, flow or PIN");
        const existing = state.entries.find((e) => e.name === input.name);
        if (existing) {
          state.entries = state.entries.map((e) =>
            e === existing ? { ...e, gmailAccount: readOnlyAccount } : e,
          );
        } else {
          state.entries.push({
            ...start,
            kind: "gmail",
            fields: [],
            gmailAccount: readOnlyAccount,
          });
        }
        break;
      }
      case "gmail-disconnect":
        if (Redacted.value(input.pin) !== PIN) throw new Error("Wrong disconnect PIN");
        state.entries = state.entries.flatMap((entry) => {
          if (entry.name !== input.name) return [entry];
          if (!state.gmailUserCredentials && entry.kind === "gmail") return [];
          const { gmailAccount: _removed, ...rest } = entry;
          return [rest];
        });
        break;
      default:
        throw new Error("Unexpected vault action");
    }
    return AsyncResult.success(result);
  });
}

it("saves a private client before consent, reconnects without resaving and retains it on disconnect", async () => {
  await setup();
  enableGmail();
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Add credential", exact: true }).click();
  await page.getByRole("button", { name: "Gmail", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Personal mail");
  const dialog = gmailDialog();
  const redirect = dialog.getByLabelText("OAuth redirect URL");
  await expect.element(redirect).toHaveAttribute("readonly");
  await expect.element(redirect).toHaveValue(localOrigin + callbackPath);
  await expect.element(dialog.getByLabelText("Client secret")).toHaveAttribute("type", "password");
  await fillGoogleClient();
  await dialog.getByRole("button", { name: "Save client" }).click();
  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.run.mock.calls[0]?.[0].input).toMatchObject({
    action: "gmail-configure",
    clientId,
    redirectUri: localOrigin + callbackPath,
  });
  const configured = state.run.mock.calls[0]![0].input;
  expect(() => Redacted.value(configured.clientSecret)).toThrow();
  expect(() => Redacted.value(configured.pin)).toThrow();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect
    .element(screen.getByText("Google client saved · no mailbox connected"))
    .toBeVisible();
  await screen.getByRole("button", { name: "Connect Personal mail", exact: true }).click();
  await expect.element(dialog.getByLabelText("Vault PIN")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Continue to Google" }).click();
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(googleConsent);
  expect(state.run.mock.calls[1]?.[0]).toEqual({
    environmentId,
    input: {
      action: "gmail-start",
      name: expect.stringMatching(/^entry-[0-9a-f]{32}$/),
      title: "Personal mail",
    },
  });
  const finish = page.getByRole("button", { name: "Finish connection" });
  await expect.element(finish).toBeDisabled();
  state.fail = true;
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await finish.click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Google consent is not complete.");
  await expect.element(page.getByLabelText("Vault PIN", { exact: true })).toHaveValue("");
  state.fail = false;
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await finish.click();
  await expect
    .element(screen.getByText(`Read-only Gmail: ${readOnlyAccount}`, { exact: false }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Edit Personal mail" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Disconnect Personal mail", exact: true }).click();
  const disconnect = page.getByRole("button", { name: "Disconnect", exact: true });
  await expect.element(disconnect).toBeDisabled();
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await disconnect.click();
  await expect
    .element(screen.getByText("Google client saved · no mailbox connected"))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Delete Personal mail" })).toBeEnabled();
  expect(state.run.mock.calls.map(([{ input }]) => input.action)).toEqual([
    "gmail-configure",
    "gmail-start",
    "gmail-finish",
    "gmail-finish",
    "gmail-disconnect",
  ]);
});

it("restarts failed Google consent with a fresh attempt and clears the previous PIN", async () => {
  await setup();
  enableGmail();
  state.entries = [savedMailbox()];
  const freshConsent = new URL(googleConsent);
  freshConsent.searchParams.set("state", "fresh-google-attempt");
  state.run
    .mockResolvedValueOnce(
      AsyncResult.success({
        error: null,
        gmailAuthorization: { url: googleConsent, flowId: "expired-flow" },
      }),
    )
    .mockResolvedValueOnce(
      AsyncResult.success({
        error: "This Gmail connection is no longer available. Start the connection again.",
      }),
    )
    .mockResolvedValueOnce(
      AsyncResult.success({
        error: null,
        gmailAuthorization: { url: freshConsent.href, flowId: "fresh-flow" },
      }),
    )
    .mockResolvedValueOnce(AsyncResult.success({ error: null }));
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Connect Personal mail", exact: true }).click();
  const dialog = gmailDialog();
  await dialog.getByRole("button", { name: "Continue to Google", exact: true }).click();
  await dialog.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await dialog.getByRole("button", { name: "Finish connection", exact: true }).click();
  await expect.element(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Restart Google sign-in", exact: true }).click();
  expect(state.openExternal.mock.calls.map(([url]) => url)).toEqual([
    googleConsent,
    freshConsent.href,
  ]);
  await expect.element(dialog.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(dialog.getByLabelText("Vault PIN", { exact: true })).toHaveValue("");
  await dialog.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await dialog.getByRole("button", { name: "Finish connection", exact: true }).click();
  expect(state.run.mock.calls.at(-1)?.[0].input).toMatchObject({
    action: "gmail-finish",
    name: "mail",
    flowId: "fresh-flow",
  });
});

it("manages an existing mixed mailbox on its exact login without offering setup on unrelated rows", async () => {
  await setup();
  setRoute("BearerConnectionTarget", remoteOrigin);
  const consent = consentFor(remoteOrigin + callbackPath);
  enableGmail(consent);
  state.gmailRedirectUri = remoteOrigin + callbackPath;
  state.entries = [
    {
      name: "legacy-id",
      title: "Work",
      kind: "login",
      fields: ["username", "password"],
      origin: "https://example.test",
      gmailClient: { clientId, redirectUri: remoteOrigin + callbackPath },
    },
    { name: "unrelated", title: "Other login", kind: "login", fields: ["username", "password"] },
  ];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Connect Other login", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Connect Work", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(gmailDialog().getByRole("textbox", { name: "Search credentials" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Continue to Google" }).click();
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(consent);
  expect(state.run.mock.calls[0]?.[0].input).toEqual({
    action: "gmail-start",
    name: "legacy-id",
    title: "Work",
  });
  await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Finish connection" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Disconnect Work", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Edit Work", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Website", exact: true }))
    .toHaveValue("https://example.test");
});

it("cancels a private edit, clears secrets on error and rejects a non-Google consent destination", async () => {
  await setup();
  enableGmail();
  state.entries = [savedMailbox()];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  const edit = () => screen.getByRole("button", { name: "Edit client for Personal mail" }).click();
  const dialog = gmailDialog();
  await edit();
  await expect.element(dialog.getByLabelText("Client ID")).toHaveValue(clientId);
  await expect.element(dialog.getByLabelText("Client secret")).toHaveValue("");
  await dialog.getByLabelText("Client ID").fill("other.apps.googleusercontent.com");
  await dialog.getByLabelText("Vault PIN").fill(PIN);
  const save = dialog.getByRole("button", { name: "Save client" });
  await expect.element(save).toBeDisabled();
  await dialog.getByLabelText("Client secret").fill("synthetic-client-secret");
  state.fail = true;
  await save.click();
  await expect.element(dialog.getByRole("alert")).toBeVisible();
  await expect
    .element(dialog.getByText("synthetic-client-secret", { exact: false }))
    .not.toBeInTheDocument();
  await expect.element(dialog.getByLabelText("Vault PIN")).toHaveValue("");
  await expect.element(dialog.getByLabelText("Client secret")).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(state.entries).toEqual([savedMailbox()]);
  expect(state.openExternal).not.toHaveBeenCalled();
  state.fail = false;
  await edit();
  await dialog.getByLabelText("Vault PIN").fill(PIN);
  await save.click();
  expect(state.run.mock.calls[1]?.[0].input).not.toHaveProperty("clientSecret");
  state.run.mockResolvedValueOnce(
    AsyncResult.success({
      error: null,
      gmailAuthorization: {
        flowId: "test-flow",
        url: "https://accounts.google.com.example.test/o/oauth2/v2/auth",
      },
    }),
  );
  await expect.element(dialog.getByRole("button", { name: "Continue to Google" })).toBeVisible();
  await expectGmailStartRejection(invalidConsent);
  expect(state.openExternal).not.toHaveBeenCalled();
});

it.each([
  ["BearerConnectionTarget", remoteOrigin],
  ["SshConnectionTarget", localOrigin],
  ["RelayConnectionTarget", localOrigin],
  ["PrimaryConnectionTarget", "http://127.0.0.1:3773"],
] as const)(
  "rejects a loopback Gmail callback on %s at %s before consent or PIN",
  async (kind, origin) => {
    await setup();
    enableGmail();
    state.entries = [savedMailbox()];
    setRoute(kind, origin);
    await using screen = await render(
      <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
    );
    await screen.getByRole("button", { name: "Connect Personal mail", exact: true }).click();
    using fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected probe"));
    await expect.element(gmailDialog().getByRole("alert")).toHaveTextContent(unreachableCallback);
    await expect
      .element(gmailDialog().getByRole("button", { name: "Continue to Google" }))
      .toBeDisabled();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.readPreparedConnection).toHaveBeenCalledWith(environmentId);
    expect(state.openExternal).not.toHaveBeenCalled();
    const discovery = `${window.location.origin}/.well-known/t3/environment`;
    expect(fetch.mock.calls.filter(([url]) => String(url) !== discovery)).toEqual([]);
  },
);

it("checks an alternate public HTTPS callback without sending auth, then opens Google only for the selected environment", async () => {
  await setup();
  setRoute("SshConnectionTarget", localOrigin);
  const consent = consentFor(remoteOrigin + callbackPath);
  enableGmail(consent);
  state.gmailRedirectUri = remoteOrigin + callbackPath;
  state.entries = [savedMailbox(remoteOrigin + callbackPath)];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Connect Personal mail", exact: true }).click();
  const dialog = gmailDialog();
  let respondingId = "wrong-environment";
  using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      environmentId: respondingId,
      label: "Remote",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    }),
  );
  await expectGmailStartRejection(unreachableCallback);
  expect(state.openExternal).not.toHaveBeenCalled();
  respondingId = environmentId;
  await dialog.getByRole("button", { name: "Continue to Google", exact: true }).click();
  await expect.element(dialog.getByRole("button", { name: "Finish connection" })).toBeVisible();
  await expect.element(dialog.getByRole("alert")).not.toBeInTheDocument();
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(consent);
  const discovery = `${window.location.origin}/.well-known/t3/environment`;
  const probes = fetch.mock.calls.filter(([url]) => String(url) !== discovery);
  expect(probes).toHaveLength(2);
  for (const [url, init] of probes) {
    expect(String(url)).toBe(`${remoteOrigin}/.well-known/t3/environment`);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    const headers = new Headers(init?.headers);
    for (const name of ["Authorization", "Cookie", "DPoP"]) expect(headers.has(name)).toBe(false);
    expect(init?.body).toBeFalsy();
  }
});

it.each([
  `${googleEndpoint}?state=only`,
  googleConsent.replace(clientId, "another.apps.googleusercontent.com"),
  `${googleConsent}&client_id=${clientId}`,
  `${googleConsent}&client_secret=unexpected`,
  `${googleConsent}&redirect_uri=${encodeURIComponent(remoteOrigin + callbackPath)}`,
  `${googleConsent}#fragment`,
  consentFor(`http://localhost:13773${callbackPath}`),
  consentFor(`http://mail.example.test${callbackPath}`),
  consentFor(`https://person@mail.example.test${callbackPath}`),
  consentFor(`${localOrigin}/x/..${callbackPath}`),
  consentFor(`${localOrigin}${callbackPath}?`),
  consentFor(`${localOrigin}${callbackPath}#`),
])("rejects ambiguous or noncanonical Google consent URL %s", async (url) => {
  await setup();
  enableGmail(url);
  state.entries = [savedMailbox()];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Connect Personal mail", exact: true }).click();
  await expectGmailStartRejection(invalidConsent);
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("replaces a stale saved registration with the advertised callback before starting consent", async () => {
  await setup();
  enableGmail(consentFor(remoteOrigin + callbackPath));
  state.gmailRedirectUri = remoteOrigin + callbackPath;
  state.entries = [savedMailbox("https://other.example.test" + callbackPath)];
  setRoute("BearerConnectionTarget", remoteOrigin);
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Connect Personal mail", exact: true }).click();
  const dialog = gmailDialog();
  await expect
    .element(dialog.getByLabelText("OAuth redirect URL"))
    .toHaveValue(remoteOrigin + callbackPath);
  await expect
    .element(dialog.getByRole("button", { name: "Continue to Google" }))
    .not.toBeInTheDocument();
  expect(state.run).not.toHaveBeenCalled();
  await dialog.getByLabelText("Vault PIN").fill(PIN);
  await dialog.getByRole("button", { name: "Save client" }).click();
  expect(state.run.mock.calls[0]?.[0].input).toMatchObject({
    action: "gmail-configure",
    redirectUri: state.gmailRedirectUri,
  });
  await expect.element(dialog.getByRole("button", { name: "Continue to Google" })).toBeEnabled();
  expect(state.openExternal).not.toHaveBeenCalled();
});

it.each([
  undefined,
  "https://192.168.1.5/oauth/gmail/callback",
  "https://mail.internal/oauth/gmail/callback",
])(
  "does not invent a direct HTTPS callback or probe an alternate private host (%s)",
  async (advertised) => {
    await setup();
    enableGmail();
    state.gmailRedirectUri = advertised;
    setRoute("BearerConnectionTarget", remoteOrigin);
    await using screen = await render(
      <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
    );
    using fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected probe"));
    await screen.getByRole("button", { name: "Add credential", exact: true }).click();
    await page.getByRole("button", { name: "Gmail", exact: true }).click();
    const dialog = gmailDialog();
    await expect.element(dialog.getByRole("alert")).toHaveTextContent(unreachableCallback);
    await expect.element(dialog.getByLabelText("Client secret")).toBeDisabled();
    await expect.element(dialog.getByRole("button", { name: "Save client" })).toBeDisabled();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.openExternal).not.toHaveBeenCalled();
    const discovery = `${window.location.origin}/.well-known/t3/environment`;
    expect(fetch.mock.calls.filter(([url]) => String(url) !== discovery)).toEqual([]);
  },
);

it("hides Gmail on environments that do not advertise support", async () => {
  await setup();
  state.entries = [{ name: "work", title: "Work", kind: "token", fields: ["token"] }];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Add credential", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add credential", exact: true });
  await expect
    .element(picker.getByRole("button", { name: "Gmail", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(picker.getByRole("button", { name: "API token", exact: true }))
    .toBeEnabled();
});

it.each([false, true])(
  "withholds per-entry setup on older hosts (gmailAvailable=%s) but permits legacy disconnect",
  async (available) => {
    await setup();
    enableGmail();
    state.gmailAvailable = available;
    state.gmailUserCredentials = undefined;
    state.gmailRedirectUri = undefined;
    state.entries = [
      {
        name: "mail",
        title: "Personal mail",
        kind: "gmail",
        fields: [],
        gmailAccount: readOnlyAccount,
      },
      { name: "work", title: "Work", kind: "token", fields: ["token"] },
    ];
    await using screen = await render(
      <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Reconnect Personal mail", exact: true }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Disconnect Personal mail", exact: true }).click();
    const disconnect = page.getByRole("button", { name: "Disconnect", exact: true });
    await expect.element(disconnect).toBeDisabled();
    expect(state.run).not.toHaveBeenCalled();
    await page.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
    await disconnect.click();
    await expect
      .element(screen.getByText("Personal mail", { exact: true }))
      .not.toBeInTheDocument();
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { action: "gmail-disconnect", name: "mail", pin: expect.anything() },
    });
  },
);

it.each(["insecure RPC", "insecure socket", "wrong environment", "wrong descriptor"])(
  "rejects Google setup before collecting a secret: %s",
  async (scenario) => {
    await setup();
    enableGmail(consentFor(remoteOrigin + callbackPath));
    setRoute("BearerConnectionTarget", remoteOrigin);
    const route = state.readPreparedConnection(environmentId);
    state.readPreparedConnection.mockReturnValue({
      ...route,
      ...(scenario === "insecure RPC" ? { httpBaseUrl: "http://remote.test" } : {}),
      ...(scenario === "insecure socket" ? { socketUrl: "ws://remote.test/ws" } : {}),
      ...(scenario === "wrong environment" ? { environmentId: "other" } : {}),
      ...(scenario === "wrong descriptor" ? { descriptor: { environmentId: "other" } } : {}),
    });
    await using screen = await render(
      <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
    );
    await expect.element(screen.getByRole("button", { name: "Add credential" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Change PIN" })).toBeDisabled();
    await expect.element(page.getByLabelText("Client secret")).not.toBeInTheDocument();
    expect(state.run).not.toHaveBeenCalled();
  },
);

const picker = () => page.getByRole("dialog", { name: "Add credential", exact: true });
const serviceDialog = (service: VaultTokenService) =>
  page.getByRole("dialog", { name: `${VAULT_SERVICE_LABELS[service]} credential`, exact: true });

it.each(VAULT_TOKEN_SERVICES)(
  "searches for %s, verifies its token, then rotates the same connection",
  async (service) => {
    await setup();
    state.credentialServices = ["gmail", ...VAULT_TOKEN_SERVICES];
    const label = VAULT_SERVICE_LABELS[service];
    const tokenLabel = service === "slack" ? "Bot token" : "Access token";
    let replacement = false;
    state.run.mockImplementation(async ({ input }) => {
      expect(input).toMatchObject({
        action: "connect-service",
        service,
        title: "Work",
        name: expect.stringMatching(/^entry-[0-9a-f]{32}$/),
      });
      expect(Redacted.value(input.token)).toBe(
        replacement ? "synthetic-rotated-token" : "synthetic-test-token",
      );
      expect(Redacted.value(input.pin)).toBe(PIN);
      if (replacement) expect(input.name).toBe(state.entries[0]?.name);
      state.entries = [
        {
          name: input.name,
          title: input.title,
          kind: "service",
          fields: [],
          serviceConnection: { service, account: "test-account" },
        },
      ];
      return AsyncResult.success({ error: null, entries: state.entries, names: [input.name] });
    });
    await using screen = await render(
      <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
    );
    await screen.getByRole("button", { name: "Add credential", exact: true }).click();
    await picker().getByRole("textbox", { name: "Search credentials" }).fill("unavailable service");
    await expect
      .element(picker().getByRole("status"))
      .toHaveTextContent("No matching credentials. Try another name.");
    await picker().getByRole("textbox", { name: "Search credentials" }).fill(label.toLowerCase());
    await expect
      .element(picker().getByRole("button", { name: "Gmail", exact: true }))
      .not.toBeInTheDocument();
    await picker().getByRole("button", { name: label, exact: true }).click();
    const dialog = serviceDialog(service);
    await expect
      .element(dialog.getByRole("link", { name: `Credential settings at ${label}` }))
      .toBeVisible();
    const secret = dialog.getByLabelText(tokenLabel, { exact: true });
    await expect.element(secret).toHaveAttribute("type", "password");
    await dialog.getByLabelText("Name", { exact: true }).fill("Work");
    await secret.fill("synthetic-test-token");
    const submit = dialog.getByRole("button", { name: "Verify and save" });
    await expect.element(submit).toBeDisabled();
    await dialog.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
    await submit.click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Connection: test-account", { exact: true }))
      .toBeVisible();
    expect(state.run).toHaveBeenCalledTimes(1);
    const sent = state.run.mock.calls[0]![0].input;
    expect(() => Redacted.value(sent.token)).toThrow();
    expect(() => Redacted.value(sent.pin)).toThrow();
    await expect
      .element(screen.getByRole("button", { name: "Copy reference" }))
      .not.toBeInTheDocument();
    replacement = true;
    await screen.getByRole("button", { name: "Edit Work", exact: true }).click();
    await expect.element(picker()).not.toBeInTheDocument();
    await expect.element(dialog.getByLabelText("Name", { exact: true })).toHaveValue("Work");
    await expect.element(secret).toHaveValue("");
    await secret.fill("synthetic-rotated-token");
    await dialog.getByLabelText("Vault PIN", { exact: true }).fill(PIN);
    await submit.click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(state.run).toHaveBeenCalledTimes(2);
  },
);

it("rotates only the selected service and clears every protected field on failed verification", async () => {
  await setup();
  state.credentialServices = ["gitlab", "slack"];
  const old: LocalVaultEntry = {
    name: "selected",
    title: "Deploy",
    kind: "service",
    fields: [],
    serviceConnection: { service: "gitlab", account: "existing-account" },
  };
  const other: LocalVaultEntry = { name: "keep", title: "Keep", kind: "token", fields: ["token"] };
  state.entries = [old, other];
  state.run.mockImplementation(async ({ input }) => {
    if (input.action === "remove") {
      expect(input.name).toBe("selected");
      expect(Redacted.value(input.pin)).toBe(PIN);
      state.entries = [other];
      return AsyncResult.success({ error: null });
    }
    expect(input).toMatchObject({
      action: "connect-service",
      service: "gitlab",
      name: "selected",
      title: "Deploy",
    });
    return AsyncResult.success({ error: `Do not display ${Redacted.value(input.token)}` });
  });
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Edit Deploy", exact: true }).click();
  const dialog = serviceDialog("gitlab");
  await expect.element(picker()).not.toBeInTheDocument();
  await expect
    .element(dialog.getByText("Connection: existing-account", { exact: true }))
    .toBeVisible();
  const token = dialog.getByLabelText("Access token", { exact: true });
  const pin = dialog.getByLabelText("Vault PIN", { exact: true });
  await expect.element(token).toHaveValue("");
  await token.fill("synthetic-rejected-token");
  await pin.fill(PIN);
  await dialog.getByRole("button", { name: "Verify and save" }).click();
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent(
      "Credential not saved. Check the token, its read permissions, and your vault PIN, then try again.",
    );
  await expect.element(token).toHaveValue("");
  await expect.element(pin).toHaveValue("");
  await expect
    .element(dialog.getByText("synthetic-rejected-token", { exact: false }))
    .not.toBeInTheDocument();
  expect(() => Redacted.value(state.run.mock.calls[0]![0].input.token)).toThrow();
  expect(() => Redacted.value(state.run.mock.calls[0]![0].input.pin)).toThrow();
  expect(state.entries).toEqual([old, other]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await screen.getByRole("button", { name: "Delete Deploy", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "Delete vault entry" });
  await removal.getByLabelText("Vault PIN").fill(PIN);
  await removal.getByRole("button", { name: "Delete entry", exact: true }).click();
  await expect.element(screen.getByText("Deploy", { exact: true })).not.toBeInTheDocument();
  expect(state.entries).toEqual([other]);
});

it("lists only advertised services even when an older Gmail capability is present", async () => {
  await setup();
  enableGmail();
  state.credentialServices = ["slack"];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await screen.getByRole("button", { name: "Add credential", exact: true }).click();
  for (const [id, name] of Object.entries(VAULT_SERVICE_LABELS)) {
    if (id === "slack") continue;
    await expect
      .element(picker().getByRole("button", { name, exact: true }))
      .not.toBeInTheDocument();
  }
  await expect.element(picker().getByRole("button", { name: "Slack", exact: true })).toBeEnabled();
  await expect
    .element(picker().getByRole("button", { name: "Website login", exact: true }))
    .toBeEnabled();
});

it("withholds all editors without manage permission", async () => {
  await setup();
  state.permission = Atom.make(false);
  state.credentialServices = ["slack"];
  await using screen = await render(
    <LocalVaultSettings environmentId={environmentId} encrypted legacy={false} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Add credential", exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Change PIN" })).not.toBeInTheDocument();
  await expect.element(page.getByLabelText("Vault PIN")).not.toBeInTheDocument();
  expect(state.run).not.toHaveBeenCalled();
});
