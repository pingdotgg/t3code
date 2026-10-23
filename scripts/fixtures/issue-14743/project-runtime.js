(async () => {
  window.proofEvents = [];
  window.proofWrites = [];
  window.proofAcks = [];
  const oldSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    let d;
    try {
      d = JSON.parse(data);
    } catch {}
    if (d?.tag === "server.updateSettings") {
      proofWrites.push({ at: new Date().toISOString(), ...d });
      if (!this.proofWatching) {
        this.proofWatching = true;
        this.addEventListener("message", (e) => {
          let a;
          try {
            a = JSON.parse(e.data);
          } catch {}
          if (a?.requestId && proofWrites.some((w) => w.id === a.requestId)) {
            proofAcks.push({ at: new Date().toISOString(), ...a });
            window.dispatchEvent(new Event("proofAck"));
          }
        });
      }
    }
    return oldSend.call(this, data);
  };
  let counter = 94000;
  const socket = new WebSocket("ws://localhost:7763/ws?orchestrationProtocol=2");
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = j;
  });
  window.proofRpc = (tag, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = String(++counter);
      const h = (e) => {
        const d = JSON.parse(e.data);
        if (d.requestId === id) {
          socket.removeEventListener("message", h);
          resolve(d);
        }
      };
      socket.addEventListener("message", h);
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  window.proofThemeLog = [
    { at: new Date().toISOString(), className: document.documentElement.className },
  ];
  new MutationObserver(() =>
    proofThemeLog.push({
      at: new Date().toISOString(),
      className: document.documentElement.className,
    }),
  ).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  for (const type of ["click", "keydown", "focusin", "focusout"])
    document.addEventListener(
      type,
      (e) =>
        proofEvents.push({
          at: new Date().toISOString(),
          type,
          key: e.key,
          target: e.target.getAttribute?.("aria-label") || e.target.textContent?.slice(0, 50),
        }),
      true,
    );
  window.proofWait30 = () =>
    new Promise((resolve) => {
      const check = () => {
        if (
          proofAcks.some(
            (a) =>
              a.exit?.value?.projectSettingsOverrides?.["proof-project"]?.worktreeCleanup?.rules
                ?.worktreeAfterDays === 30,
          )
        ) {
          window.removeEventListener("proofAck", check);
          resolve(true);
        }
      };
      window.addEventListener("proofAck", check);
      check();
    });
  return "installed";
})();
