/**
 * Echo fixture for the floci Actions test (`../../Actions.local.test.ts`),
 * deployed with `bundle: false`: returns the invocation event so an
 * `InvokeFunction` Action can prove the call reached THIS function on the
 * emulator.
 */
export const handler = async (event) => ({
  echoed: event,
  from: "floci-echo",
});
