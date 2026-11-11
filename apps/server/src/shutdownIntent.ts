// Process-wide, like the signals that set it: once the server is being stopped, its provider
// processes die with it, and their exits must not overwrite what restart recovery reads.
let recorded = false;

export const recordShutdownIntent = (): void => {
  recorded = true;
};

export const isShutdownIntentRecorded = (): boolean => recorded;
