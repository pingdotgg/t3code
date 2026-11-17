import { MAX_BYTES, type UploadRow } from "../../src/policy.ts";
import "./style.css";

const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const account = element<HTMLFormElement>("#account");
const upload = element<HTMLFormElement>("#upload");
const message = element("#message");
const files = element("#files");
const empty = element("#empty");
const signout = element<HTMLButtonElement>("#signout");
const uploadButton = element<HTMLButtonElement>("#upload-button");
const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
const authUrl = import.meta.env.VITE_NEON_AUTH_URL;
let signedIn = false;
let generation = 0;
const show = (text: string, error = false) => {
  message.textContent = text;
  message.dataset.error = String(error);
};
const explain = (error: unknown) =>
  show(error instanceof Error ? error.message : "Request failed. Please try again.", true);

async function start() {
  if (!apiUrl || !authUrl) {
    show(
      "Backend not configured. Deploy the stack, or set VITE_API_URL and VITE_NEON_AUTH_URL before starting Vite. No demo backend is substituted.",
      true,
    );
    account.querySelectorAll("button").forEach((button) => (button.disabled = true));
    return;
  }
  const { createAuthClient } = await import("@neondatabase/neon-js/auth");
  const auth = createAuthClient(authUrl);
  const authBaseUrl = authUrl.replace(/\/$/, "");

  function clearSession() {
    signedIn = false;
    generation++;
    files.replaceChildren();
    empty.textContent = "Sign in to see your files.";
    account.hidden = false;
    signout.hidden = true;
    uploadButton.disabled = true;
    element("#identity").textContent = "Signed out";
  }

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    // The pinned auth SDK aliases /token to its getSession cache.
    const tokenResponse = await fetch(`${authBaseUrl}/token`, {
      credentials: "include",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await tokenResponse.json().catch(() => undefined);
    if (!tokenResponse.ok || typeof data?.token !== "string" || !data.token) {
      clearSession();
      throw new Error("Your session has expired. Sign in again.");
    }
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${data.token}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) clearSession();
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new Error(body?.error ?? `Request failed (HTTP ${response.status}).`);
    }
    return response.json();
  }

  async function refresh() {
    if (!signedIn) {
      show("Sign in to view uploads.");
      return [];
    }
    const current = generation;
    const rows = await api<UploadRow[]>("/api/uploads");
    if (current !== generation) return [];
    files.replaceChildren();
    empty.textContent = rows.length ? "" : "No uploads yet. Add your first file above.";
    for (const row of rows) {
      const item = document.createElement("li");
      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = row.filename;
      const status = document.createElement("span");
      status.className = "file-status";
      status.textContent =
        row.status === "ready"
          ? `Ready · ${row.actual_bytes} bytes`
          : row.status === "rejected"
            ? "Rejected · uploaded metadata did not match"
            : "Awaiting upload event / processing";
      text.append(name, status);
      item.append(text);
      if (row.status === "ready") {
        const button = document.createElement("button");
        button.className = "secondary";
        button.textContent = "Download";
        button.addEventListener("click", () => {
          button.disabled = true;
          api<{ url: string }>(`/api/uploads/${row.id}/download`)
            .then(({ url }) => {
              // Navigate directly: the signed GET does not require cross-origin fetch or cookies.
              const link = document.createElement("a");
              link.href = url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              link.click();
              show("Opened a private download URL. It expires in 60 seconds.");
            })
            .catch(explain)
            .finally(() => (button.disabled = false));
        });
        item.append(button);
      }
      files.append(item);
    }
    return rows;
  }

  async function session() {
    const result = await auth.getSession();
    if (result.error) throw new Error(result.error.message ?? "Could not read your session.");
    if (!result.data?.user) {
      clearSession();
      return;
    }
    signedIn = true;
    generation++;
    element("#identity").textContent = `Signed in as ${result.data.user.email}`;
    account.hidden = true;
    signout.hidden = false;
    uploadButton.disabled = false;
    await refresh();
  }

  account.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = new FormData(account);
    const mode = (event.submitter as HTMLButtonElement).value;
    const input = {
      name: String(fields.get("name")),
      email: String(fields.get("email")),
      password: String(fields.get("password")),
    };
    account.querySelectorAll("button").forEach((button) => (button.disabled = true));
    show(mode === "signup" ? "Creating your account…" : "Signing in…");
    const request = mode === "signup" ? auth.signUp.email(input) : auth.signIn.email(input);
    request
      .then(async (result) => {
        if (result.error) throw new Error(result.error.message ?? "Authentication failed.");
        account.querySelector<HTMLInputElement>('[name="password"]')!.value = "";
        await session();
        show(
          signedIn ? "Signed in. Your files are private." : "Check your email to complete sign-in.",
        );
      })
      .catch(explain)
      .finally(() =>
        account.querySelectorAll("button").forEach((button) => (button.disabled = false)),
      );
  });

  signout.addEventListener("click", () => {
    signout.disabled = true;
    auth
      .signOut()
      .then((result) => {
        if (result.error) throw new Error(result.error.message ?? "Signout failed.");
        clearSession();
        show("Signed out. Your session has ended.");
      })
      .catch(explain)
      .finally(() => (signout.disabled = false));
  });

  upload.addEventListener("submit", (event) => {
    event.preventDefault();
    const file = element<HTMLInputElement>('[name="file"]').files?.[0];
    if (!file || file.size < 1 || file.size > MAX_BYTES) {
      show("Choose a nonempty file up to 10 MiB.", true);
      return;
    }
    uploadButton.disabled = true;
    const current = generation;
    const run = async () => {
      show("Requesting a short-lived upload URL…");
      const signed = await api<{
        id: string;
        url: string;
        contentType: string;
      }>("/api/uploads", {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        }),
      });
      show("Uploading directly to private storage…");
      const response = await fetch(signed.url, {
        method: "PUT",
        body: file,
        headers: { "content-type": signed.contentType },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(
          `Storage upload failed (HTTP ${response.status}). Request a new upload URL by trying again.`,
        );
      upload.reset();
      show("Uploaded. Waiting for the real bucket event…");
      for (let attempt = 0; attempt < 9 && current === generation; attempt++) {
        const rows = await refresh();
        const row = rows.find((value) => value.id === signed.id);
        if (row?.status === "ready") {
          show("Processed successfully. Your download is ready.");
          return;
        }
        if (row?.status === "rejected")
          throw new Error("The uploaded file did not match its declared metadata.");
        if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (current === generation)
        show(
          "The upload event is still pending. Use Refresh status to check again; no processing success has been assumed.",
        );
    };
    run()
      .catch(explain)
      .finally(() => (uploadButton.disabled = !signedIn));
  });
  element("#refresh").addEventListener("click", () => {
    refresh().catch(explain);
  });
  await session();
  show(
    signedIn
      ? "Welcome back. Your upload journal is ready."
      : "Create an account or sign in to start.",
  );
}

start().catch(explain);
