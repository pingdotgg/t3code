/**
 * Maps react-grab's element context onto the source frame the picker reports.
 * Lives in its own module, free of both electron and react-grab at runtime, so
 * it is trivially unit-testable — `PickPreload.ts` installs listeners on import
 * and cannot be loaded from a test.
 */
import type { PickedElementStackFrame } from "@t3tools/contracts";

/**
 * react-grab resolves an element's source location independently of its call
 * stack, so a component whose stack came back empty can still know its file.
 * Reading only the first stack frame therefore dropped the file and line for
 * most picks, leaving the agent with a selector and no route back to source.
 *
 * Structurally typed rather than taking `ReactGrabElementContext` so callers
 * only have to supply what is actually read.
 */
export function pickedElementSource(context: {
  readonly componentName: string | null;
  readonly filePath: string | null;
  readonly lineNumber: number | null;
  readonly columnNumber: number | null;
}): PickedElementStackFrame | null {
  if (!context.filePath) return null;
  return {
    functionName: context.componentName,
    fileName: context.filePath,
    lineNumber: context.lineNumber,
    columnNumber: context.columnNumber,
  };
}
