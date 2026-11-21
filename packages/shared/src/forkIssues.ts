/**
 * Fork-only. Lathe tracks work in its Roadmap, so upstream's Issues tracker ships switched off: the
 * server advertises no `issues` capabilities and registers no issue tools for agents, and clients
 * hide what reads them. Flip this to turn Issues on everywhere.
 */
export const LATHE_SHOWS_UPSTREAM_ISSUES: boolean = false;
