import {
  createNotificationEnvironmentAtoms,
  EMPTY_NOTIFICATION_EDGES,
} from "@t3tools/client-runtime/state/notifications";
import type { NotificationDecidedEdge } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const notificationEnvironment = createNotificationEnvironmentAtoms(connectionAtomRuntime);

/**
 * Decided edges from the primary environment, newest last.
 *
 * The web transport only follows the primary environment: an in-app toast is a
 * statement about the workspace the user is looking at, and every other
 * environment surfaces through the sidebar inbox instead.
 */
export const primaryNotificationEdgesAtom = Atom.make(
  (get): ReadonlyArray<NotificationDecidedEdge> => {
    const environmentId = get(primaryEnvironmentIdAtom);
    if (environmentId === null) {
      return EMPTY_NOTIFICATION_EDGES;
    }
    return Option.getOrElse(
      AsyncResult.value(get(notificationEnvironment.edgeFeed(environmentId))),
      () => EMPTY_NOTIFICATION_EDGES,
    );
  },
).pipe(Atom.withLabel("web-primary-notification-edges"));
