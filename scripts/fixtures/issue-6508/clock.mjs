// Fixture preload; wall clock is fixed while Node timers and performance.now stay real.
const RealDate = globalThis.Date;
const ms = RealDate.parse("2026-10-22T10:00:00.000Z");
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [ms]));
  }
  static now() {
    return ms;
  }
};
