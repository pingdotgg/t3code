import { Observe } from "expo-observe";

// Crash reports could only leave through T3 Connect. Observe keeps its last configuration across
// launches, so a build that once sent them must turn sending off.
Observe.configure({ dispatchingEnabled: false });
