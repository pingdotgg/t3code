/**
 * workerd logs every error a step callback throws as an uncaught promise
 * rejection, even when the workflow catches it. The timer quota regression
 * test in engine.test.ts fails 5,100 steps on purpose, which floods the
 * output with 10,000+ identical stack lines, so drop that test's error.
 */
const FLOOD = "Error: immediate step failure";

export default function setup() {
  // oxlint-disable-next-line typescript/unbound-method -- saved only to restore the original on teardown; calls go through the bound `forward`
  const write = process.stdout.write;
  const forward = write.bind(process.stdout) as (...args: Array<unknown>) => boolean;
  process.stdout.write = ((chunk: unknown, ...rest: Array<unknown>) =>
    String(chunk).includes(FLOOD) || forward(chunk, ...rest)) as typeof process.stdout.write;
  return () => {
    process.stdout.write = write;
  };
}
