let latestOpen = false;
let firstWritePending = false;

/** Alternating atomic live regions allow repeated user actions to be announced, as in VS Code aria.ts. */
export function announceSidebarVisibility(open: boolean) {
  latestOpen = open;
  if (firstWritePending) return;
  let container = document.getElementById("workspace-visibility-alerts");
  const created = !container;
  if (!container) {
    container = document.createElement("div");
    container.id = "workspace-visibility-alerts";
    container.className = "sr-only";
    for (let index = 0; index < 2; index++) {
      const alert = document.createElement("div");
      alert.setAttribute("aria-live", "polite");
      alert.setAttribute("aria-atomic", "true");
      container.append(alert);
    }
    document.body.append(container);
  }
  const [first, second] = Array.from(container.children);
  const write = () => {
    firstWritePending = false;
    const next = first!.textContent ? second! : first!;
    first!.textContent = "";
    second!.textContent = "";
    next.textContent = `Sidebar ${latestOpen ? "shown" : "hidden"}`;
  };
  // Screen readers ignore text written in the same task that inserts its live region.
  // Toggles during that delay only update the state the pending write announces.
  if (created) {
    firstWritePending = true;
    setTimeout(write, 100);
  } else write();
}
