const OPEN_EVENT = "t3code:open-agent-dashboard-window";
export function openAgentDashboardWindow() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** The document is a portal target only; it never bootstraps another client or connection. */
export function installDashboardPopupHost(onChange: (popup: Window | null) => void) {
  let child: Window | null = null;
  let observer: MutationObserver | null = null;
  const closed = () => {
    observer?.disconnect();
    observer = null;
    child?.removeEventListener("beforeunload", closed);
    child = null;
    onChange(null);
  };
  const open = () => {
    if (child && !child.closed) {
      child.focus();
      return;
    }
    child = window.open("about:blank", "t3-agent-dashboard", "width=1120,height=760");
    if (!child) return;
    child.document.title = "Agent Dashboard — T3 Code";
    const syncTheme = () => {
      if (!child || child.closed) return;
      for (const attribute of Array.from(child.document.documentElement.attributes))
        child.document.documentElement.removeAttribute(attribute.name);
      for (const attribute of Array.from(document.documentElement.attributes))
        child.document.documentElement.setAttribute(attribute.name, attribute.value);
    };
    syncTheme();
    for (const node of Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]')))
      child.document.head.appendChild(node.cloneNode(true));
    child.document.body.style.cssText = "margin:0; height:100vh; display:flex; overflow:hidden";
    child.document.body.className = document.body.className;
    observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true });
    child.addEventListener("beforeunload", closed, { once: true });
    onChange(child);
  };
  window.addEventListener(OPEN_EVENT, open);
  return () => {
    window.removeEventListener(OPEN_EVENT, open);
    observer?.disconnect();
    observer = null;
    if (child) {
      child.removeEventListener("beforeunload", closed);
      if (!child.closed) child.close();
      child = null;
    }
  };
}
