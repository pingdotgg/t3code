// Atlas Vector login gate (Step 4) — least-invasive: authenticates the user
// against Vector's FastAPI (JWT) and gates the app IN FRONT of T3's own
// connection/pairing flow, which keeps securing the agent WebSocket underneath.
//
// New atlas-namespaced file; the only upstream touch is one wrap in main.tsx.
// When VITE_ATLAS_API_URL is unset this component is a pass-through, so upstream
// (non-Atlas) behavior is preserved.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

const TOKEN_KEY = "atlas.token";
const API_URL = import.meta.env.VITE_ATLAS_API_URL?.trim();
const AUTOPAIR = import.meta.env.VITE_ATLAS_AUTOPAIR === "1";

export interface AtlasUser {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly role: string;
}

export function getAtlasToken(): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
}
function setAtlasToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearAtlasToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function loginRequest(email: string, password: string): Promise<{ token: string; user: AtlasUser }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login_failed");
  const data = (await res.json()) as { access_token: string; user: AtlasUser };
  return { token: data.access_token, user: data.user };
}

async function fetchMe(token: string): Promise<AtlasUser | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AtlasUser;
  } catch {
    return null;
  }
}

/**
 * When auto-pair is enabled, fetch the long-lived pairing token the server
 * published same-origin (/atlas-autopair.json) and hand it to T3's existing
 * `/pair#token=...` auto-submit. Returns true if it triggered a redirect, so
 * the caller stops rendering. A sessionStorage guard (set only once we actually
 * redirect) prevents loops while still retrying in a fresh tab.
 */
async function tryAutoPair(): Promise<boolean> {
  if (!AUTOPAIR || sessionStorage.getItem("atlas.autopair.tried")) return false;
  try {
    const res = await fetch("/atlas-autopair.json", { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { token?: string };
    if (!data.token) return false;
    sessionStorage.setItem("atlas.autopair.tried", "1");
    window.location.replace(`/pair#token=${encodeURIComponent(data.token)}`);
    return true;
  } catch {
    return false;
  }
}

type GateState = "loading" | "authed" | "anon";

export function AtlasAuthGate({ children }: { readonly children: ReactNode }) {
  // Not configured for Atlas → behave exactly like upstream T3.
  if (!API_URL) return <>{children}</>;

  const [state, setState] = useState<GateState>("loading");

  useEffect(() => {
    const token = getAtlasToken();
    if (!token) {
      setState("anon");
      return;
    }
    void fetchMe(token).then(async (user) => {
      if (!user) {
        clearAtlasToken();
        setState("anon");
        return;
      }
      if (await tryAutoPair()) return; // redirecting to /pair#token=...
      setState("authed");
    });
  }, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        Carregando…
      </div>
    );
  }
  if (state === "authed") return <>{children}</>;
  return (
    <AtlasLogin
      onSuccess={() => {
        // Mirror the mount-effect auto-pair so a fresh login lands in the app
        // (not the manual /pair screen) when auto-pair is enabled.
        setState("loading");
        void tryAutoPair().then((redirected) => {
          if (!redirected) setState("authed");
        });
      }}
    />
  );
}

function AtlasLogin({ onSuccess }: { readonly onSuccess: (user: AtlasUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await loginRequest(email, password);
      setAtlasToken(token);
      onSuccess(user);
    } catch {
      setError("E-mail ou senha inválidos");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-7 shadow-lg"
      >
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Atlas Vector</h1>
          <p className="text-sm text-muted-foreground">Entre para acessar seus deals</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-foreground">E-mail</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-foreground">Senha</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
