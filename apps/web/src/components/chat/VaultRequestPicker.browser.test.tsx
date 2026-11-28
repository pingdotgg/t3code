import "~/index.css";
import {
  AuthSettingsWriteScope,
  EnvironmentId,
  ThreadId,
  TurnItemId,
  VAULT_TOKEN_SERVICES,
  type LocalVaultEntry,
  type VaultTokenService,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";
import { SecretRequestCard } from "./SecretRequestCard";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { VaultRequestPicker } from "./VaultRequestPicker";

import type * as LocalApi from "../../localApi";

const state = vi.hoisted(() => ({
  answer: vi.fn(),
  manage: vi.fn(),
  managePermission: null as unknown,
  openExternal: vi.fn(),
  readPreparedConnection: vi.fn(),
  gmailUserCredentials: true as true | undefined,
  allowed: true,
  missingScope: "",
  loading: false,
  services: [] as VaultTokenService[],
  refresh: vi.fn(),
  entries: [] as LocalVaultEntry[],
  config: undefined as unknown,
}));
vi.mock("./WorkLog", () => ({ WorkLogRow: () => null }));
vi.mock("./useVaultApprovalToast", () => ({ useVaultApprovalToast: () => {} }));
vi.mock("../settings/SecretSourceInput", () => ({ SecretSourceSelect: () => null }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: EnvironmentId, scope: string) =>
    state.allowed && state.missingScope !== scope,
  readPreparedConnection: state.readPreparedConnection,
  usePreparedConnection: (id: EnvironmentId) =>
    Option.fromNullishOr(state.readPreparedConnection(id)),
}));
vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof LocalApi>()),
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: object) => ("permissionAtom" in command ? state.manage : state.answer),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    localVault: () => ({}),
    manageLocalVault: { permissionAtom: () => state.managePermission },
    answerSecretRequest: {},
    configValueAtom: () => state.config,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      names: state.entries.map((e) => e.name),
      entries: state.entries,
      credentialServices: state.services,
      gmailAvailable: true,
      gmailUserCredentials: state.gmailUserCredentials,
      gmailRedirectUri: "http://127.0.0.1:13773/oauth/gmail/callback",
      error: null,
      security: { configured: true, canSetInitialPin: true, retryAt: 0 },
    },
    error: null,
    isPending: state.loading,
    refresh: state.refresh,
  }),
}));
const environmentId = EnvironmentId.make("test-vault");
const item = {
  type: "secret_request",
  id: TurnItemId.make("request"),
  threadId: ThreadId.make("thread"),
  runId: "run",
  nodeId: "node",
  label: "Sign in to GitHub",
  reason: "Use your test account.",
  url: "https://github.com/login",
  secretStatus: "pending",
  fields: [
    { name: "email", label: "Email" },
    { name: "password", label: "Password" },
  ],
};
function setup() {
  state.allowed = true;
  state.missingScope = "";
  state.loading = false;
  state.services = [...VAULT_TOKEN_SERVICES];
  state.managePermission = Atom.make(true);
  state.manage.mockReset();
  state.openExternal.mockReset();
  state.readPreparedConnection.mockReset();
  state.gmailUserCredentials = true;
  state.readPreparedConnection.mockReturnValue({
    environmentId,
    descriptor: { environmentId },
    target: { _tag: "PrimaryConnectionTarget" },
    httpBaseUrl: "http://127.0.0.1:13773",
    socketUrl: "ws://127.0.0.1:13773/ws",
  });
  state.config = Atom.make({
    localSecretStorage: "linux-keyring-aes256gcm",
    localVaultEntries: true,
    vaultPinSecurity: true,
  });
  state.answer.mockReset();
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  state.entries = [
    {
      name: "work",
      title: "GitHub work",
      kind: "login",
      access: "allow",
      fields: ["username", "password"],
      origin: "https://github.com",
    },
    {
      name: "other",
      title: "Another website",
      kind: "login",
      fields: ["username", "password"],
      origin: "https://evil.test",
    },
  ];
}
it("offers Allow from vault directly on a credential request and opens its PIN approval", async () => {
  setup();
  state.entries.push({ name: "mail", title: "Mailbox only", kind: "gmail", fields: [] });
  state.entries.push({
    name: "service-only",
    title: "Service only",
    kind: "service",
    fields: [],
    serviceConnection: { service: "github", account: "sample" },
  });
  state.entries[0] = { ...state.entries[0]!, access: "ask" };
  await using screen = await render(
    <SecretRequestCard
      environmentId={environmentId}
      item={item as unknown as SecretRequestItem}
      visibility="local"
    />,
  );
  await screen.getByRole("button", { name: "Allow from vault", exact: true }).click();
  await screen.getByRole("combobox", { name: "Saved entry", exact: true }).click();
  await expect.element(page.getByRole("option", { name: "Mailbox only" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("option", { name: "Service only" })).not.toBeInTheDocument();
  await page.getByRole("option", { name: "GitHub work", exact: true }).click();
  await expect.element(screen.getByLabelText("Vault PIN", { exact: true })).toBeVisible();
  expect(state.answer).not.toHaveBeenCalled();
});
it("asks only for a vault PIN on a tagged request and never opens an entry picker", async () => {
  setup();
  const { fields: _fields, ...request } = item;
  await using screen = await render(
    <SecretRequestCard
      environmentId={environmentId}
      item={
        {
          ...request,
          label: "Webhook token",
          taggedVault: { name: "hook", field: "token" },
        } as unknown as SecretRequestItem
      }
      visibility="local"
    />,
  );
  const approve = screen.getByRole("button", { name: "Approve for this request" });
  await expect.element(approve).toBeDisabled();
  await expect.element(screen.getByRole("combobox")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Save securely" }))
    .not.toBeInTheDocument();
  await screen.getByLabelText("Vault PIN", { exact: true }).fill("8472951");
  await approve.click();
  expect(state.answer).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "vault", name: "hook", fields: { value: "token" }, pin: expect.anything() },
    },
  });
});

const mailbox = {
  name: "mail",
  title: "Personal",
  kind: "login",
  fields: ["username", "password"],
} as const;
const gmailAccount = "personal@example.test";
const googleClient = {
  clientId: "123-test.apps.googleusercontent.com",
  redirectUri: "http://127.0.0.1:13773/oauth/gmail/callback",
};
function gmailCard(needsConnection: boolean, secretStatus: "pending" | "saved" = "pending") {
  const { fields: _fields, url: _url, ...request } = item;
  return (
    <SecretRequestCard
      environmentId={environmentId}
      item={
        {
          ...request,
          label: mailbox.title,
          secretStatus,
          taggedVault: {
            name: mailbox.name,
            gmail: { folder: "spam", limit: 5 },
            ...(needsConnection ? { needsGmailConnection: true } : {}),
          },
        } as SecretRequestItem
      }
      visibility="local"
    />
  );
}

it("shows five private rows even when the saved event arrives before the Gmail reply", async () => {
  setup();
  state.entries.push({ ...mailbox, gmailClient: googleClient, gmailAccount });
  const reply = Promise.withResolvers<unknown>();
  state.answer.mockReturnValue(reply.promise);
  await using screen = await render(gmailCard(false));
  await expect.element(screen.getByRole("combobox")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Personal · Spam · latest 5 messages")).toBeVisible();
  await expect.element(screen.getByText(`Gmail account: ${gmailAccount}`)).toBeVisible();
  const pin = screen.getByLabelText("Vault PIN", { exact: true });
  await pin.fill("8472951");
  await screen.getByRole("button", { name: "Show messages privately" }).click();
  await expect.element(pin).toHaveValue("");
  expect(state.answer).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      threadId: item.threadId,
      turnItemId: item.id,
      answer: {
        type: "vault_gmail_display",
        name: mailbox.name,
        account: gmailAccount,
        pin: expect.anything(),
      },
    },
  });
  await screen.rerender(gmailCard(false, "saved"));
  const rows = Array.from({ length: 5 }, (_, i) => ({
    from: `sender-${i}@example.test`,
    date: "today",
    subject: `<a href="/">mail ${i}</a>`,
    snippet: `preview ${i}`,
  }));
  reply.resolve(AsyncResult.success({ messages: rows }));
  for (const row of rows) await expect.element(screen.getByText(row.subject)).toBeVisible();
  await expect.element(screen.getByRole("link")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Hide private list" }).click();
  await expect.element(screen.getByText("preview 0")).not.toBeInTheDocument();
});

it("connects the selected mailbox, then requires a fresh approval on the original Gmail card", async () => {
  setup();
  state.entries.push(mailbox);
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ redirect_uri: googleClient.redirectUri, client_id: googleClient.clientId })}`;
  state.manage.mockImplementationOnce(async ({ input }) => {
    if (
      input.name !== mailbox.name ||
      input.clientId !== googleClient.clientId ||
      Redacted.value(input.pin) !== "8472951" ||
      Redacted.value(input.clientSecret) !== "synthetic-secret"
    )
      throw new Error("Unexpected configure request");
    state.entries = state.entries.map((entry) =>
      entry.name === mailbox.name ? { ...entry, gmailClient: googleClient } : entry,
    );
    return AsyncResult.success({ error: null, entries: state.entries });
  });
  state.manage.mockResolvedValueOnce(
    AsyncResult.success({ error: null, gmailAuthorization: { flowId: "flow", url } }),
  );
  state.manage.mockImplementationOnce(async () => {
    state.entries = state.entries.map((entry) =>
      entry.name === mailbox.name ? { ...entry, gmailAccount } : entry,
    );
    return AsyncResult.success({ error: null, entries: state.entries });
  });
  state.answer.mockResolvedValueOnce(AsyncResult.success({ messages: [] }));
  await using screen = await render(gmailCard(true));
  const pin = screen.getByLabelText("Vault PIN", { exact: true });
  await expect.element(pin).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Set up connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Credential connection" });
  await expect.element(dialog.getByLabelText("Name", { exact: true })).not.toBeInTheDocument();
  await expect.element(dialog.getByRole("combobox")).not.toBeInTheDocument();
  await dialog.getByLabelText("Client ID").fill(googleClient.clientId);
  await dialog.getByLabelText("Client secret").fill("synthetic-secret");
  await dialog.getByLabelText("Vault PIN").fill("8472951");
  await dialog.getByRole("button", { name: "Save client" }).click();
  expect(state.answer).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
  await expect.element(dialog.getByLabelText("Vault PIN")).not.toBeInTheDocument();
  await dialog.getByRole("button", { name: "Continue to Google" }).click();
  expect(state.manage.mock.calls[1]?.[0]).toEqual({
    environmentId,
    input: { action: "gmail-start", name: mailbox.name, title: mailbox.title },
  });
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  await dialog.getByLabelText("Vault PIN", { exact: true }).fill("8472951");
  await dialog.getByRole("button", { name: "Finish connection" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(state.answer).not.toHaveBeenCalled();
  await expect.element(pin).toHaveValue("");
  await pin.fill("8472951");
  await screen.getByRole("button", { name: "Show messages privately" }).click();
  expect(state.answer.mock.calls[0]?.[0].input.turnItemId).toBe(item.id);
  await expect.element(screen.getByText("No messages found.")).toBeVisible();
});

it.each([false, true])(
  "cancels tagged Gmail onboarding and declines without reading mail (client saved: %s)",
  async (saved) => {
    setup();
    state.entries.push(saved ? { ...mailbox, gmailClient: googleClient } : mailbox);
    await using screen = await render(gmailCard(true));
    await screen.getByRole("button", { name: "Set up connection" }).click();
    const dialog = page.getByRole("dialog");
    if (saved) {
      const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: googleClient.clientId, redirect_uri: googleClient.redirectUri })}`;
      state.manage.mockResolvedValueOnce(
        AsyncResult.success({ error: null, gmailAuthorization: { flowId: "flow", url } }),
      );
      await expect.element(dialog.getByLabelText("Client secret")).not.toBeInTheDocument();
      await expect.element(dialog.getByLabelText("Vault PIN")).not.toBeInTheDocument();
      await dialog.getByRole("button", { name: "Continue to Google" }).click();
      await expect.element(dialog.getByRole("button", { name: "Finish connection" })).toBeVisible();
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect
      .element(screen.getByLabelText("Vault PIN", { exact: true }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Decline" }).click();
    expect(state.answer).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: item.threadId, turnItemId: item.id, answer: { type: "decline" } },
    });
    expect(state.manage.mock.calls.map(([{ input }]) => input.action)).toEqual(
      saved ? ["gmail-start"] : [],
    );
  },
);

it("clears a typed read PIN when the selected entry changes Gmail accounts", async () => {
  setup();
  state.entries.push({ ...mailbox, gmailClient: googleClient, gmailAccount });
  await using screen = await render(gmailCard(false));
  const pin = screen.getByLabelText("Vault PIN", { exact: true });
  await pin.fill("8472951");
  const next = "another@example.test";
  state.entries = [{ ...mailbox, gmailClient: googleClient, gmailAccount: next }];
  await screen.rerender(gmailCard(true));
  await expect.element(screen.getByText(`Gmail account: ${next}`)).toBeVisible();
  await expect.element(pin).toHaveValue("");
  await expect
    .element(screen.getByRole("button", { name: "Show messages privately" }))
    .toBeDisabled();
  expect(state.answer).not.toHaveBeenCalled();
});

it("withholds the read PIN without mailbox lookup permission but still allows decline", async () => {
  setup();
  state.managePermission = Atom.make(false);
  state.entries.push({ ...mailbox, gmailClient: googleClient, gmailAccount });
  await using screen = await render(gmailCard(false));
  await expect
    .element(
      screen.getByText("This session cannot approve this read. Use a session with vault access."),
    )
    .toBeVisible();
  await expect.element(screen.getByLabelText("Vault PIN", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Show messages privately" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Decline" }).click();
  expect(state.answer.mock.calls.map(([{ input }]) => input.answer)).toEqual([{ type: "decline" }]);
});

it("does not retry with agent sharing if the host returns no private list", async () => {
  setup();
  state.entries.push({ ...mailbox, gmailClient: googleClient, gmailAccount });
  await using screen = await render(gmailCard(false));
  await screen.getByLabelText("Vault PIN", { exact: true }).fill("8472951");
  await screen.getByRole("button", { name: "Show messages privately" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The environment returned no private list.");
  expect(state.answer).toHaveBeenCalledTimes(1);
});

it.each(["old host", "remote HTTP"])(
  "offers no private PIN or Google setup on %s",
  async (scenario) => {
    setup();
    state.entries.push({ ...mailbox, gmailClient: googleClient, gmailAccount });
    if (scenario === "old host") state.gmailUserCredentials = undefined;
    else {
      const route = state.readPreparedConnection(environmentId);
      state.readPreparedConnection.mockReturnValue({ ...route, httpBaseUrl: "http://remote.test" });
    }
    await using screen = await render(gmailCard(true));
    await expect.element(screen.getByLabelText("Vault PIN")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Set up connection" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(state.manage).not.toHaveBeenCalled();
    expect(state.answer).not.toHaveBeenCalled();
  },
);

const revision = "a".repeat(32);
const serviceEntry = (service: VaultTokenService): LocalVaultEntry => ({
  name: "selected",
  title: "Work",
  kind: "service",
  fields: [],
  serviceConnection: { service, account: "team-fixture", revision },
});
function serviceCard(service: VaultTokenService, secretStatus: "pending" | "saved" = "pending") {
  const { fields: _fields, url: _url, ...request } = item;
  return (
    <SecretRequestCard
      environmentId={environmentId}
      item={
        {
          ...request,
          label: "Work",
          secretStatus,
          taggedVault: { name: "selected", serviceRead: { service, limit: 1 }, revision },
        } as SecretRequestItem
      }
      visibility="local"
    />
  );
}

it.each([
  ["github", "List GitHub repositories"],
  ["gitlab", "List GitLab membership projects"],
  ["slack", "List Slack public channels"],
  ["airtable", "List Airtable bases"],
  ["asana", "List Asana workspaces"],
  ["linear", "List Linear teams"],
  ["netlify", "List Netlify sites"],
  ["notion", "List shared Notion pages"],
  ["todoist", "List Todoist projects"],
  ["typeform", "List Typeform forms"],
  ["vercel", "List Vercel projects"],
] as const)(
  "privately lists the tagged %s credential with one account-bound PIN",
  async (service, operation) => {
    setup();
    state.entries = [serviceEntry(service)];
    const reply = Promise.withResolvers<unknown>();
    state.answer.mockReturnValue(reply.promise);
    await using screen = await render(serviceCard(service));
    await expect.element(screen.getByText(`Work · ${operation} (up to 1)`)).toBeVisible();
    await expect.element(screen.getByText("Connection: team-fixture")).toBeVisible();
    await expect.element(screen.getByRole("combobox")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("checkbox")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Allow from vault" }))
      .not.toBeInTheDocument();
    const pin = screen.getByLabelText("Vault PIN", { exact: true });
    const approve = screen.getByRole("button", { name: "Show items privately" });
    await expect.element(approve).toBeDisabled();
    await pin.fill("8472951");
    await approve.click();
    expect(state.answer).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        threadId: item.threadId,
        turnItemId: item.id,
        answer: {
          type: "vault_service_display",
          name: "selected",
          account: "team-fixture",
          pin: expect.anything(),
        },
      },
    });
    await screen.rerender(serviceCard(service, "saved"));
    await expect.element(screen.getByText("Waiting for private results…")).toBeVisible();
    reply.resolve(
      AsyncResult.success({
        items: [
          { label: "<a>sample</a>", detail: "first\u202eitem", internal: "must not appear" },
          { label: "over limit" },
        ],
      }),
    );
    await expect.element(screen.getByText("<a>sample</a>")).toBeVisible();
    await expect.element(screen.getByText("first item")).toBeVisible();
    await expect.element(screen.getByRole("link")).not.toBeInTheDocument();
    await expect.element(screen.getByText("over limit")).not.toBeInTheDocument();
    await expect.element(screen.getByText("must not appear")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Hide private list" }).click();
    await expect.element(screen.getByText("<a>sample</a>")).not.toBeInTheDocument();
  },
);

it.each([
  "missing scope",
  "wrong service",
  "missing capability",
  "rotated token",
  "unverified host",
  "loading",
])("permits only decline for a private service read: %s", async (scenario) => {
  setup();
  state.entries = [serviceEntry(scenario === "wrong service" ? "slack" : "github")];
  if (scenario === "missing scope") state.missingScope = AuthSettingsWriteScope;
  if (scenario === "missing capability") state.services = [];
  if (scenario === "rotated token") {
    state.entries = [
      {
        ...serviceEntry("github"),
        serviceConnection: { service: "github", account: "team-fixture", revision: "b".repeat(32) },
      },
    ];
  }
  if (scenario === "loading") state.loading = true;
  if (scenario === "unverified host") {
    const connection = state.readPreparedConnection(environmentId);
    state.readPreparedConnection.mockReturnValue({
      ...connection,
      descriptor: { environmentId: "other" },
    });
  }
  await using screen = await render(serviceCard("github"));
  await expect.element(screen.getByLabelText("Vault PIN")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Show items privately" }))
    .not.toBeInTheDocument();
  if (scenario === "loading")
    await expect.element(screen.getByRole("status")).toHaveTextContent("Loading entries…");
  await screen.getByRole("button", { name: "Decline" }).click();
  expect(state.answer).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId: item.threadId, turnItemId: item.id, answer: { type: "decline" } },
  });
  expect(state.manage).not.toHaveBeenCalled();
});

it("drops the private PIN on an account change and clears the result when vault access is lost", async () => {
  setup();
  const route = state.readPreparedConnection(environmentId);
  state.readPreparedConnection.mockReturnValue({
    ...route,
    httpBaseUrl: "https://fixture.test",
    socketUrl: "wss://fixture.test/ws",
  });
  state.entries = [serviceEntry("slack")];
  state.answer.mockResolvedValue(AsyncResult.success({ items: [{ label: "private-channel" }] }));
  await using screen = await render(serviceCard("slack"));
  const pin = screen.getByLabelText("Vault PIN", { exact: true });
  await pin.fill("8472951");
  state.entries = [
    {
      ...serviceEntry("slack"),
      serviceConnection: { service: "slack", account: "another-team", revision },
    },
  ];
  await screen.rerender(serviceCard("slack"));
  await expect.element(screen.getByText("Connection: another-team")).toBeVisible();
  await expect.element(pin).toHaveValue("");
  await expect.element(screen.getByRole("button", { name: "Show items privately" })).toBeDisabled();
  await pin.fill("8472951");
  await screen.getByRole("button", { name: "Show items privately" }).click();
  await expect.element(screen.getByText("private-channel")).toBeVisible();
  state.missingScope = AuthSettingsWriteScope;
  await screen.rerender(serviceCard("slack", "saved"));
  await expect.element(screen.getByText("private-channel")).not.toBeInTheDocument();
  state.missingScope = "";
  await screen.rerender(serviceCard("slack", "saved"));
  await expect.element(screen.getByText("Private read approved")).toBeVisible();
  await expect.element(screen.getByText("private-channel")).not.toBeInTheDocument();
  expect(state.answer).toHaveBeenCalledTimes(1);
});

it("rejects a mailbox reply to a service read without exposing it or falling back", async () => {
  setup();
  state.entries = [serviceEntry("slack")];
  state.answer.mockResolvedValue(
    AsyncResult.success({ messages: [{ subject: "unexpected mailbox row" }] }),
  );
  await using screen = await render(serviceCard("slack"));
  await screen.getByLabelText("Vault PIN").fill("8472951");
  await screen.getByRole("button", { name: "Show items privately" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The environment returned no private list.");
  await expect.element(screen.getByText("unexpected mailbox row")).not.toBeInTheDocument();
  expect(state.answer).toHaveBeenCalledTimes(1);
});

it("maps a saved login to request fields and approves references, not credential values", async () => {
  setup();
  await using screen = await render(
    <VaultRequestPicker environmentId={environmentId} item={item} onBack={() => {}} />,
  );
  await screen.getByRole("combobox", { name: "Saved entry", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: "Another website · Different website", exact: true }))
    .toHaveAttribute("aria-disabled", "true");
  await page.getByRole("option", { name: "GitHub work", exact: true }).click();
  await expect
    .element(screen.getByRole("combobox", { name: "Use for Email", exact: true }))
    .toHaveTextContent("Username or email");
  await expect
    .element(screen.getByRole("combobox", { name: "Use for Password", exact: true }))
    .toHaveTextContent("Password");
  await screen.getByRole("button", { name: "Approve for this request", exact: true }).click();
  expect(state.answer).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "vault", name: "work", fields: { email: "username", password: "password" } },
    },
  });
});
it("offers no login for an unspecified website and keeps approval disabled", async () => {
  setup();
  await using screen = await render(
    <VaultRequestPicker
      environmentId={environmentId}
      item={(({ url: _url, ...request }) => request)(item)}
      onBack={() => {}}
    />,
  );
  await screen.getByRole("combobox", { name: "Saved entry", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: "GitHub work · Different website", exact: true }))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(screen.getByRole("button", { name: "Approve for this request", exact: true }))
    .toBeDisabled();
});
it("requires explicit mapping for unknown field names, including prototype names", async () => {
  setup();
  await using screen = await render(
    <VaultRequestPicker
      environmentId={environmentId}
      item={{ ...item, fields: [{ name: "constructor", label: "Custom field" }] }}
      onBack={() => {}}
    />,
  );
  await screen.getByRole("combobox", { name: "Saved entry", exact: true }).click();
  await page.getByRole("option", { name: "GitHub work", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Approve for this request", exact: true }))
    .toBeDisabled();
  await screen.getByRole("combobox", { name: "Use for Custom field", exact: true }).click();
  await page.getByRole("option", { name: "Username or email", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Approve for this request", exact: true }))
    .toBeEnabled();
});
it("distinguishes command access from protected credential delivery", async () => {
  setup();
  await using screen = await render(
    <VaultRequestPicker
      environmentId={environmentId}
      item={{ ...item, delivery: "file" }}
      onBack={() => {}}
    />,
  );
  await screen.getByRole("combobox", { name: "Saved entry", exact: true }).click();
  await page.getByRole("option", { name: "GitHub work", exact: true }).click();
  await expect
    .element(
      screen.getByText(
        "Command access is not a browser sandbox. After approval, the agent's commands can read these fields and are not restricted to the saved website.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Approve command access", exact: true }))
    .toBeDisabled();
  await screen.getByLabelText("Vault PIN", { exact: true }).fill("8472951");
  await expect
    .element(screen.getByRole("button", { name: "Approve command access", exact: true }))
    .toBeDisabled();
  await screen
    .getByRole("checkbox", {
      name: "Allow this agent's commands to read the real selected fields for this request.",
      exact: true,
    })
    .click();
  await expect
    .element(screen.getByRole("button", { name: "Approve command access", exact: true }))
    .toBeEnabled();
});
it("requires a PIN for ask-first entries even for protected use", async () => {
  setup();
  state.entries[0] = { ...state.entries[0]!, access: "ask" };
  await using screen = await render(
    <VaultRequestPicker environmentId={environmentId} item={item} onBack={() => {}} />,
  );
  await screen.getByRole("combobox", { name: "Saved entry", exact: true }).click();
  await page.getByRole("option", { name: "GitHub work", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Approve for this request", exact: true }))
    .toBeDisabled();
  await screen.getByLabelText("Vault PIN", { exact: true }).fill("123");
  await expect
    .element(screen.getByRole("button", { name: "Approve for this request", exact: true }))
    .toBeDisabled();
  await screen.getByLabelText("Vault PIN", { exact: true }).fill("8472951");
  await expect
    .element(screen.getByRole("button", { name: "Approve for this request", exact: true }))
    .toBeEnabled();
});
it("does not offer approval without the required permissions", async () => {
  setup();
  state.allowed = false;
  await using screen = await render(
    <VaultRequestPicker environmentId={environmentId} item={item} onBack={() => {}} />,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Saved entry", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Approve for this request", exact: true }))
    .toBeDisabled();
});
