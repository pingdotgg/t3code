import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";
import { definePluginComponent } from "~/plugins/features";

const BrowserManagedAuthShell = definePluginComponent(
  "component:components/clerk/BrowserManagedAuthShell/BrowserManagedAuthShell",
  PluginOriginalBrowserManagedAuthShell,
);
export default BrowserManagedAuthShell;

/** Lazy-load Clerk so cloudless local mode never downloads it. */
function PluginOriginalBrowserManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
