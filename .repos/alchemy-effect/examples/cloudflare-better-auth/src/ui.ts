import { authClient } from "./client.ts";

const form = document.querySelector<HTMLFormElement>("#auth-form")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const sessionOutput = document.querySelector<HTMLPreElement>("#session")!;
const meOutput = document.querySelector<HTMLPreElement>("#me")!;
const providers = document.querySelector<HTMLDivElement>("#providers")!;
const name = document.querySelector<HTMLInputElement>("#name")!;
const email = document.querySelector<HTMLInputElement>("#email")!;
const password = document.querySelector<HTMLInputElement>("#password")!;

async function refresh() {
  const session = await authClient.getSession();
  if (session.error) throw new Error(session.error.message ?? "Session lookup failed");
  sessionOutput.textContent = JSON.stringify(
    session.data ? { user: session.data.user, expiresAt: session.data.session.expiresAt } : null,
    null,
    2,
  );
  const response = await fetch("/api/me");
  const body = await response.json();
  meOutput.textContent = `${response.status}\n${JSON.stringify(body, null, 2)}`;
  if (!response.ok && response.status !== 401) {
    throw new Error(`The private API returned ${response.status}`);
  }
}

async function run(action: () => Promise<void>) {
  const buttons = document.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  status.textContent = "Working…";
  try {
    await action();
    status.textContent = "Ready";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

form.addEventListener("submit", (event) => event.preventDefault());

document.querySelector("#sign-up")!.addEventListener("click", () => {
  if (!form.reportValidity()) return;
  if (!name.value.trim()) {
    status.textContent = "Enter a name to sign up.";
    return;
  }
  void run(async () => {
    const result = await authClient.signUp.email({
      name: name.value.trim(),
      email: email.value,
      password: password.value,
    });
    if (result.error) throw new Error(result.error.message ?? "Sign up failed");
    password.value = "";
    await refresh();
  });
});

document.querySelector("#sign-in")!.addEventListener("click", () => {
  if (!form.reportValidity()) return;
  void run(async () => {
    const result = await authClient.signIn.email({
      email: email.value,
      password: password.value,
    });
    if (result.error) throw new Error(result.error.message ?? "Sign in failed");
    password.value = "";
    await refresh();
  });
});

document.querySelector("#sign-out")!.addEventListener("click", () => {
  void run(async () => {
    const result = await authClient.signOut();
    if (result.error) throw new Error(result.error.message ?? "Sign out failed");
    await refresh();
  });
});

document.querySelector("#refresh")!.addEventListener("click", () => void run(refresh));

void run(async () => {
  const response = await fetch("/api/providers");
  if (!response.ok) throw new Error(`Provider lookup returned ${response.status}`);
  const enabled: { github: boolean } = await response.json();
  if (enabled.github) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Continue with GitHub";
    button.addEventListener("click", () => {
      void run(async () => {
        const result = await authClient.signIn.social({
          provider: "github",
          callbackURL: "/",
        });
        if (result.error) throw new Error(result.error.message ?? "GitHub sign in failed");
      });
    });
    providers.append(button);
  }
  await refresh();
});
