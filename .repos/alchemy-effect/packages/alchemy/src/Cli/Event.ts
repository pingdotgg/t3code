import type { ProviderMode } from "../ProviderMode.ts";

export type ApplyStatus =
  | "attaching"
  | "post-attach"
  | "pending"
  | "pre-creating"
  | "creating"
  | "creating replacement"
  | "created"
  | "updating"
  | "updated"
  | "deleting"
  | "deleted"
  | "retained"
  | "replacing"
  | "replaced"
  // Action lifecycle (see {@link Action})
  | "running"
  | "ran"
  | "skipped"
  | "fail";

export type ApplyEvent = AnnotateEvent | StatusChangeEvent;

export interface AnnotateEvent {
  kind: "annotate";
  id: string;
  message: string;
}

export interface StatusChangeEvent {
  kind: "status-change";
  id: string; // resource id (e.g. "messages", "api")
  type: string; // resource type (e.g. "AWS::Lambda::Function", "Cloudflare::Worker")
  status: ApplyStatus;
  message?: string; // optional details
  bindingId?: string; // if this event is for a binding
  /**
   * The {@link ProviderMode} this node's provider was resolved for.
   * `undefined` for mode-agnostic providers (a single implementation serves
   * both dev and deploy) and for actions — renderers show nothing special.
   */
  providerMode?: ProviderMode;
  /**
   * Set only on mode-switch replacements (local ⇄ live): the mode the OLD
   * generation was created with, so renderers can annotate the transition
   * (e.g. `local → live`). Always differs from `providerMode` when set.
   */
  fromProviderMode?: ProviderMode;
}
