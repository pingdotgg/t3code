import { bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import { browserLocalServersApi } from "@t3tools/extension-sdk/catalogue";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useState } from "react";

import {
  LOCAL_SERVERS_HINT,
  LOCAL_SERVERS_LOOPBACK_LIMITATION,
  type LocalServerRow,
  type LocalServersState,
  watchLocalServers,
} from "./localServers.js";

const muted = "var(--t3-browser-muted-foreground, var(--muted-foreground, #667085))";
const headingStyle = { margin: 0, fontSize: 12, fontWeight: 500, color: muted } as const;

/**
 * `t3.browser/local-servers` while `active` (the empty state is on screen):
 * one subscription, aborted when the view hides, a session takes the panel,
 * or the view unmounts — the environment's port scanner is retained only
 * while someone is looking at the list.
 */
export function useLocalServers(
  host: ClientHost,
  session: ViewSession,
  active: boolean,
): LocalServersState {
  const [state, setState] = useState<LocalServersState>(LOADING);
  const [run, setRun] = useState({ host, session, active });
  if (run.host !== host || run.session !== session || run.active !== active) {
    // A new subscription starts in `loading`; the previous run's snapshot
    // must never paint ahead of it.
    setRun({ host, session, active });
    setState(LOADING);
  }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void watchLocalServers(
      bindStreamApi(browserLocalServersApi, host, session.context),
      signal,
      setState,
    );
    return () => controller.abort();
  }, [host, session, active]);
  return active ? state : IDLE;
}

const IDLE: LocalServersState = { kind: "idle" };
const LOADING: LocalServersState = { kind: "loading" };

export function RecentlyUsedHeading() {
  return <h2 style={headingStyle}>Recently used</h2>;
}

/** Native "No preview yet" block — rendered only when nothing else is listed. */
export function NoPreview(props: { title: string; description: string }) {
  return (
    <div aria-label={props.title} style={{ display: "grid", gap: 4, maxWidth: "36rem" }}>
      <h2 style={{ ...headingStyle, color: "inherit", fontSize: 13 }}>{props.title}</h2>
      <p style={{ margin: 0, fontSize: 12, color: muted }}>{props.description}</p>
    </div>
  );
}

/**
 * "Local servers" after "Recently used". Rows open exactly like a typed
 * address; a stream that cannot list servers renders its named reason in
 * the section's place instead of an empty list.
 */
export function LocalServersSection(props: {
  servers: readonly LocalServerRow[];
  notice: string | null;
  onOpen: (url: string) => void;
}) {
  if (props.servers.length === 0 && props.notice === null) return null;
  return (
    <div aria-label="Local servers" style={{ display: "grid", gap: 6, maxWidth: "36rem" }}>
      {props.servers.length > 0 && (
        <>
          <h2 style={headingStyle}>Local servers</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}>
            {props.servers.map((server) => (
              <li key={`${server.host}:${server.port}`}>
                <button
                  type="button"
                  onClick={() => props.onOpen(server.url)}
                  style={{
                    font: "inherit",
                    fontSize: 12,
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    padding: "2px 0",
                    textAlign: "left",
                    display: "grid",
                  }}
                >
                  <span>{server.title}</span>
                  <span style={{ color: muted }}>{server.description}</span>
                </button>
              </li>
            ))}
          </ul>
          <p style={{ margin: 0, fontSize: 11, color: muted }}>{LOCAL_SERVERS_HINT}</p>
          <p role="note" style={{ margin: 0, fontSize: 11, color: muted }}>
            {LOCAL_SERVERS_LOOPBACK_LIMITATION}
          </p>
        </>
      )}
      {props.notice !== null && (
        <p role="note" style={{ margin: 0, fontSize: 11, color: muted }}>
          {props.notice}
        </p>
      )}
    </div>
  );
}
