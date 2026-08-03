/**
 * The shapes the pure source-control logic modules read.
 *
 * These were declared locally while the contract module was still in flight;
 * now that `packages/contracts/src/workingCopy.ts` has landed this file is a
 * pure re-export shim, so there is exactly one definition of each shape and the
 * decoded wire types are what the modules are tested against.
 *
 * `WorkingCopyStatusResult` is re-exported as `WorkingCopyStatus` because the
 * modules read it as "the status", not "the result of the status call".
 *
 * fork: f4 source-control panel
 */
export type {
  WorkingCopyArea,
  WorkingCopyChange,
  WorkingCopyFile,
  WorkingCopyLogEntry,
  WorkingCopyOperation,
  WorkingCopyStatusResult as WorkingCopyStatus,
} from "@t3tools/contracts";
