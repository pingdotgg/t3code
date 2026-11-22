import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { readPairingAppLink, resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { pairEnvironment } from "../../state/use-remote-environment-registry";

// A link already asking or paired; a second open would only fail on the spent one-time token.
const takenPairingUrls = new Set<string>();

function reportFailure(message: string | null) {
  if (message !== null) Dialog.alert(m(msg("Connection failed")), message);
}

/**
 * Takes the `t3code://pair?pairingUrl=…` link that `t3 pair` prints, so navigation never sees it.
 * Any app can open the link, so the user confirms the host before its token is spent.
 */
export function takePairingAppLink(url: string): boolean {
  const pairingUrl = readPairingAppLink(url);
  if (pairingUrl === null) return false;
  if (takenPairingUrls.has(pairingUrl)) return true;
  // The origin keeps the scheme visible, so a plain HTTP backend is not mistaken for HTTPS.
  let origin: string;
  try {
    origin = new URL(resolveRemotePairingTarget({ pairingUrl }).httpBaseUrl).origin;
  } catch (error) {
    reportFailure(errorDisplayMessage(error, m) ?? m(msg("Failed to pair with the environment.")));
    return true;
  }
  takenPairingUrls.add(pairingUrl);
  Dialog.confirm({
    title: m(msg("Add environment")),
    message: m(msg("Add the environment at {origin}?"), { origin }),
    confirmText: m(msg("Add")),
    onCancel: () => takenPairingUrls.delete(pairingUrl),
    onConfirm: () => {
      void pairEnvironment(pairingUrl).then((outcome) => {
        if (outcome.ok) return;
        takenPairingUrls.delete(pairingUrl);
        reportFailure(outcome.error);
      });
    },
  });
  return true;
}
