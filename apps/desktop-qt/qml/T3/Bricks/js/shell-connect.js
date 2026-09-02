// Injected at document creation into every page the shell hosts. Defines
// `window.t3Shell` synchronously so the web app can detect the shell at module
// load (like `desktopBridge`); the channel itself connects once qwebchannel.js
// (injected alongside, order not guaranteed) has defined QWebChannel.
(() => {
  if (window.t3Shell !== undefined) {
    return;
  }
  const transport = window.qt && window.qt.webChannelTransport;
  if (!transport) {
    return;
  }
  const ready = new Promise((resolve, reject) => {
    let attempts = 0;
    const connect = () => {
      if (typeof window.QWebChannel !== "function") {
        attempts += 1;
        if (attempts > 200) {
          reject(new Error("qwebchannel.js never loaded"));
          return;
        }
        setTimeout(connect, 10);
        return;
      }
      void new window.QWebChannel(transport, (channel) => {
        const shell = channel.objects.shell;
        if (!shell) {
          reject(new Error("t3 shell object missing on the web channel"));
          return;
        }
        resolve(shell);
      });
    };
    connect();
  });
  // Everything any document published, keyed as published; secondary
  // documents (embed routes) read the primary's view models from here. The
  // map is pulled on first use: a page that never reads it (the primary) is
  // never sent its own publishes back.
  const state = {};
  const stateListeners = new Set();
  let stateReady = null;
  const ensureState = () => {
    stateReady ??= ready.then(
      (shell) =>
        new Promise((resolve) => {
          shell.stateEntryChanged.connect((key, value) => {
            state[key] = value;
            for (const listener of stateListeners) {
              listener(state);
            }
          });
          shell.snapshot((snapshot) => {
            Object.assign(state, snapshot);
            resolve(state);
          });
        }),
    );
    return stateReady;
  };
  window.t3Shell = Object.freeze({
    protocolVersion: 1,
    surfaceId:
      typeof window.__t3ShellSurfaceId === "string" ? window.__t3ShellSurfaceId : "primary",
    ready,
    publish: (key, value) => ready.then((shell) => shell.publish(key, value)),
    onAction: (listener) =>
      ready.then((shell) => {
        shell.actionRequested.connect(listener);
        return () => shell.actionRequested.disconnect(listener);
      }),
    dispatch: (action, payload) => ready.then((shell) => shell.dispatch(action, payload ?? null)),
    getState: ensureState,
    onState: (listener) =>
      ensureState().then((current) => {
        stateListeners.add(listener);
        listener(current);
        return () => stateListeners.delete(listener);
      }),
  });
})();
