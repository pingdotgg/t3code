declare module "commonmark-spec" {
  const spec: {
    readonly tests: ReadonlyArray<{ readonly markdown: string; readonly number: number }>;
  };
  export default spec;
}
