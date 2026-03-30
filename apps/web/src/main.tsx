import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { ensureBrowserPairing } from "./browserAuth";
import { initializeNativeApi } from "./nativeApi";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

document.title = APP_DISPLAY_NAME;
const UNPAIRED_RETRY_INTERVAL_MS = 1_000;

function PairingRequiredScreen() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(42rem_16rem_at_top,color-mix(in_srgb,var(--color-amber-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_92%,var(--color-black))_0%,var(--background)_56%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Browser pairing required
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This browser is not paired with the local T3 session.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Restart <code>t3</code> to open a paired browser, or open the pairing URL printed in the
          CLI.
        </p>
      </section>
    </div>
  );
}

function BootstrappedApp() {
  const [state, setState] = React.useState<"loading" | "ready" | "unpaired">("loading");

  React.useEffect(() => {
    let active = true;

    void ensureBrowserPairing()
      .then((authenticated) => {
        if (!active) return;
        if (!authenticated) {
          setState("unpaired");
          return;
        }
        initializeNativeApi();
        setState("ready");
      })
      .catch(() => {
        if (active) {
          setState("unpaired");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    if (state !== "unpaired") {
      return;
    }

    let active = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const retry = () => {
      void ensureBrowserPairing()
        .then((authenticated) => {
          if (!active || !authenticated) {
            if (active) {
              retryTimeout = setTimeout(retry, UNPAIRED_RETRY_INTERVAL_MS);
            }
            return;
          }
          initializeNativeApi();
          setState("ready");
        })
        .catch(() => {
          if (active) {
            retryTimeout = setTimeout(retry, UNPAIRED_RETRY_INTERVAL_MS);
          }
        });
    };

    retryTimeout = setTimeout(retry, UNPAIRED_RETRY_INTERVAL_MS);

    return () => {
      active = false;
      if (retryTimeout !== null) {
        clearTimeout(retryTimeout);
      }
    };
  }, [state]);

  if (state === "loading") {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  if (state === "unpaired") {
    return <PairingRequiredScreen />;
  }

  return <RouterProvider router={router} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BootstrappedApp />
  </React.StrictMode>,
);
