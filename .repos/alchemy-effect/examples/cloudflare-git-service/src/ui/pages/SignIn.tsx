/** Sign in or create an account. Sessions come from Better Auth. */
import { useState } from "react";
import { getConnection, signIn, signUp, type User } from "../client.ts";
import { Button, ErrorBox, Input, RepoIcon } from "../components.tsx";

export const SignInPage = ({
  onSignedIn,
  onCancel,
}: {
  onSignedIn: (user: User) => void;
  onCancel: () => void;
}) => {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const connection = getConnection();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === "sign-up"
          ? await signUp(connection, { name: name.trim(), email, password })
          : await signIn(connection, { email, password });
      onSignedIn(user);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-24 max-w-md px-4">
      <div className="mb-6 flex items-center justify-center gap-2 text-xl font-semibold">
        <RepoIcon className="size-6" />
        git service
      </div>
      <form
        className="space-y-4 rounded-lg border border-border-muted bg-canvas-subtle p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "sign-up" && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input value={name} onChange={setName} placeholder="Dana" />
          </label>
        )}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Email</span>
          <Input
            value={email}
            onChange={setEmail}
            type="email"
            placeholder="dana@example.com"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Password</span>
          <Input
            value={password}
            onChange={setPassword}
            type="password"
            placeholder="at least 8 characters"
          />
        </label>
        {error != null && <ErrorBox error={error} />}
        <div className="flex items-center justify-between gap-2">
          <Button
            kind="primary"
            type="submit"
            disabled={busy || !email || password.length < 8}
          >
            {busy
              ? "Working…"
              : mode === "sign-up"
                ? "Create account"
                : "Sign in"}
          </Button>
          <button
            type="button"
            className="cursor-pointer text-xs text-fg-muted hover:text-accent"
            onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}
          >
            {mode === "sign-up"
              ? "Have an account? Sign in"
              : "New here? Create an account"}
          </button>
        </div>
        <button
          type="button"
          className="cursor-pointer text-xs text-fg-muted hover:text-accent"
          onClick={onCancel}
        >
          Browse public repositories without signing in
        </button>
      </form>
    </div>
  );
};
