// Entry point for the Bare worklet started by react-native-bare-kit:
// BareKit.IPC is the duplex stream bridging to the React Native side.
/* global BareKit */
import { runP2pWorklet } from "./p2p-worklet-core.mjs";

runP2pWorklet(BareKit.IPC);
