export interface InternalWorkerModule {
  readonly main: string;
  readonly modules: Record<string, string>;
}

/** Load a prebuilt internal Worker without making its module part of the caller's build graph. */
export const loadInternalWorker = (
  specifier: string,
): Promise<InternalWorkerModule> => import(specifier);
