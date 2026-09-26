/**
 * Values only the STACK PROCESS reads — deliberately not part of any Worker
 * or Lambda bundle.
 *
 * The stress suite appends a module-scope `throw` here to simulate the
 * everyday "saved a file mid-thought" state, and needs that failure to hit
 * the stack import path ONLY. A module shared with a bundle would also take
 * the running workers down, which would test something else.
 */
export const STACK_NAME = "dev-stress";
