declare module "*.css";

// bare-pack text bundles: an ES module default-exporting the bundle source,
// fed to react-native-bare-kit's Worklet.start (see src/p2p/worklet).
declare module "*.bundle.mjs" {
  const source: string;
  export default source;
}

// Bytes helper from the Holepunch ecosystem (ships untyped); only the calls
// the P2P gateway makes are declared.
declare module "b4a" {
  const b4a: {
    toString(buffer: Uint8Array, encoding?: string): string;
    from(input: string, encoding?: string): Uint8Array;
  };
  export default b4a;
}
