let chatSidebarShortcutClaims = 0;

export function claimChatSidebarShortcut(): () => void {
  chatSidebarShortcutClaims += 1;
  return () => void (chatSidebarShortcutClaims -= 1);
}

export const hasChatSidebarShortcutClaim = () => chatSidebarShortcutClaims > 0;
