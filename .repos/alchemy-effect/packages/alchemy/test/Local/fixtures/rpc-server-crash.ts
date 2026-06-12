// Fixture that prints the marker and then immediately exits, simulating an
// RPC server that boots but crashes before the parent can use it. Used to
// exercise the spawner's retry-budget logic.
console.log("<ALCHEMY_RPC_ADDRESS>ws://127.0.0.1:1/</ALCHEMY_RPC_ADDRESS>");
process.exit(1);
