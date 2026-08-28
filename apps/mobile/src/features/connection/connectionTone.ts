import type { StatusTone } from "../../components/StatusPill";
import type { RemoteClientConnectionState } from "../../lib/connection";

export function connectionTone(state: RemoteClientConnectionState): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: "Connected",
        pillClassName: "bg-adaptive-emerald-500-a12-a16",
        textClassName: "text-adaptive-emerald-700-300",
      };
    case "reconnecting":
      return {
        label: "Reconnecting",
        pillClassName: "bg-adaptive-amber-500-a12-a16",
        textClassName: "text-adaptive-amber-700-300",
      };
    case "connecting":
      return {
        label: "Connecting",
        pillClassName: "bg-adaptive-sky-500-a12-a16",
        textClassName: "text-adaptive-sky-700-300",
      };
    case "error":
      return {
        label: "Connection failed",
        pillClassName: "bg-adaptive-rose-500-a12-a16",
        textClassName: "text-adaptive-rose-700-300",
      };
    case "offline":
      return {
        label: "Offline",
        pillClassName: "bg-adaptive-rose-500-a12-a16",
        textClassName: "text-adaptive-rose-700-300",
      };
    case "available":
      return {
        label: "Available",
        pillClassName: "bg-adaptive-neutral-500-a10-a16",
        textClassName: "text-adaptive-neutral-600-300",
      };
  }
}
