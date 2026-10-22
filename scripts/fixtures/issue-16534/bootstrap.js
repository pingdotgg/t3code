(() => {
  const NativeDate = Date,
    epoch = NativeDate.parse("2026-10-22T00:00:00.000Z");
  globalThis.Date = new Proxy(NativeDate, {
    apply() {
      return new NativeDate(epoch).toString();
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [epoch], newTarget);
    },
    get(target, property, receiver) {
      return property === "now" ? () => epoch : Reflect.get(target, property, receiver);
    },
  });
  globalThis.__sidebarCaptureClock = {
    epoch,
    readyState: document.readyState,
    moduleScripts: document.querySelectorAll('script[type="module"]').length,
  };
  const config = JSON.parse(sessionStorage.getItem("sidebar-capture-config") || "{}");
  for (const [key, value] of Object.entries(config.storage || {}))
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
})();
