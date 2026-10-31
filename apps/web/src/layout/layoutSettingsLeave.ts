/**
 * Leaving settings (Escape, the sidebar's Back) also closes the Settings tab.
 * The leave marks it here and navigates to the main app; the chat route
 * closes the tab once its own thread holds focus, so focus never passes
 * through a neighboring tab on the way out.
 */
let leavingSettings = false;

export function markLayoutSettingsLeave(): void {
  leavingSettings = true;
}

export function consumeLayoutSettingsLeave(): boolean {
  const leaving = leavingSettings;
  leavingSettings = false;
  return leaving;
}
