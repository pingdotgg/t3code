// Production bundles inline the unset flag, so Metro folds this away before collecting dependencies.
// Only mobile:behavior's and mobile:metrics' Metro sets it, including mobile:metrics' release bundle.
if (process.env.EXPO_PUBLIC_T3_BEHAVIOR_PROBE === "1") {
  // A production bundle sets up no DevTools hook; React still reports commits to one it finds.
  const global = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: object };
  if (!__DEV__)
    global.__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      checkDCE: () => {},
    };
  require("./behavior-probe");
}
