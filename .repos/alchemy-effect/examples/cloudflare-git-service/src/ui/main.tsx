import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getConnection, getSession, signOut, type User } from "./client.ts";
import { RepoIcon, ThemeToggle } from "./components.tsx";
import { RepoPage } from "./pages/Repo.tsx";
import { ReposPage } from "./pages/Repos.tsx";
import { SignInPage } from "./pages/SignIn.tsx";
import { Link, Router, segments, useRouter } from "./router.tsx";
import "./styles.css";
import { ThemeProvider } from "./theme.tsx";

/**
 * A GitHub-style browser for the deployed git-service — a plain React SPA
 * (no framework router, no Effect in the bundle) that drives the service's
 * REST API (`/api/v1`) with the Better Auth session cookie.
 *
 * Routes (GitHub-shaped):
 *
 *   /                                → repository list
 *   /:owner/:repo                    → code view (tree @ default branch)
 *   /:owner/:repo/tree/:ref/*path    → tree at path
 *   /:owner/:repo/blob/:ref/*path    → file view
 *   /:owner/:repo/commits/:ref       → commit log
 *   /:owner/:repo/commit/:oid        → one commit: message + file diffs
 *   /:owner/:repo/pulls              → pull requests (open/closed/merged)
 *   /:owner/:repo/pulls/:number      → one pull request: merge box + diffs
 *   /:owner/:repo/settings           → API keys / storage / danger zone
 */
const Header = ({
  user,
  onSignIn,
  onSignOut,
}: {
  user: User | null;
  onSignIn: () => void;
  onSignOut: () => void;
}) => (
  <header className="border-b border-border-muted bg-canvas-subtle">
    <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
      <Link to="/" className="flex items-center gap-2 font-semibold">
        <RepoIcon className="size-5" />
        git service
      </Link>
      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <ThemeToggle />
        {user !== null ? (
          <>
            <span className="hidden sm:inline">{user.name || user.email}</span>
            <button
              type="button"
              onClick={onSignOut}
              className="cursor-pointer rounded-md border border-border-muted px-2 py-1 hover:text-danger"
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            className="cursor-pointer rounded-md border border-border-muted px-2 py-1 hover:text-accent"
          >
            Sign in
          </button>
        )}
      </div>
    </div>
  </header>
);

const Routes = () => {
  const { path } = useRouter();
  const connection = getConnection();
  // `undefined` while the session probe is in flight.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [showSignIn, setShowSignIn] = useState(false);

  useEffect(() => {
    getSession(connection)
      .then(setUser)
      .catch(() => setUser(null));
  }, [connection.url]);

  if (user === undefined) return null;

  // Browsing is ANONYMOUS by default — public repos need no account. The
  // sign-in screen appears only when the user asks for it.
  if (showSignIn) {
    return (
      <SignInPage
        onSignedIn={(signedIn) => {
          setUser(signedIn);
          setShowSignIn(false);
        }}
        onCancel={() => setShowSignIn(false)}
      />
    );
  }

  const parts = segments(path);
  return (
    <>
      <Header
        user={user}
        onSignIn={() => setShowSignIn(true)}
        onSignOut={() => {
          void signOut(connection).finally(() => setUser(null));
        }}
      />
      <main className="mx-auto max-w-5xl px-4 py-6">
        {parts.length === 0 ? (
          <ReposPage connection={connection} user={user} />
        ) : parts.length >= 2 ? (
          <RepoPage
            connection={connection}
            user={user}
            owner={parts[0]!}
            name={parts[1]!.replace(/\.git$/, "")}
            rest={parts.slice(2)}
          />
        ) : (
          <div className="py-16 text-center text-fg-muted">Not found.</div>
        )}
      </main>
    </>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Router>
        <Routes />
      </Router>
    </ThemeProvider>
  </React.StrictMode>,
);
