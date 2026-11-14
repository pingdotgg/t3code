/**
 * `?worker` imports: the target bundled as a string by the Worker
 * bundler's `alchemy:worker-module` plugin (Sources/WorkerModulePlugin.ts),
 * for `WorkerLoader` modules.
 */
declare module "*?worker" {
  const source: string;
  export default source;
}
