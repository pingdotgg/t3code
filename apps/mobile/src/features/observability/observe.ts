import { Observe } from "expo-observe";

// Hyakki sends no crash reports. expo-observe is compiled into the native app and keeps its last
// configuration across launches, so it is told on every start never to dispatch.
Observe.configure({ dispatchingEnabled: false });
