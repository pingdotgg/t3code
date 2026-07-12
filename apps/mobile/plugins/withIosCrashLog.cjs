const { withAppDelegate } = require("expo/config-plugins");

const IMPORT_LINE = "internal import T3NativeControls";
const INSTALL_CALL = "Self.installNativeFatalHandlersIfNeeded()";
const METHOD_MARKER = "installNativeFatalHandlersIfNeeded";
const FLAG_MARKER = "fatalHandlersInstalled";

const FATAL_HANDLER_METHOD = `
  private static var fatalHandlersInstalled = false

  /// Hooks RN's fatal path so reportFatal leaves last-crash.json even when the
  /// JS ErrorUtils logger never flushes (the common Release Hermes failure mode).
  private static func installNativeFatalHandlersIfNeeded() {
    if fatalHandlersInstalled {
      return
    }
    fatalHandlersInstalled = true

    let previousFatal = RCTGetFatalHandler()
    let previousException = RCTGetFatalExceptionHandler()

    RCTSetFatalHandler { error in
      if let error {
        let nsError = error as NSError
        T3CrashLog.persistNativeFatal(
          message: nsError.localizedDescription,
          name: "RCTFatal",
          stack: T3CrashLog.formatJSStack(nsError.userInfo[RCTJSStackTraceKey]),
          extra: T3CrashLog.stringValue(nsError.userInfo[RCTJSExtraDataKey]),
          source: "rct-fatal"
        )
      }
      if let previousFatal {
        previousFatal(error)
      } else if let error {
        let nsError = error as NSError
        let description = nsError.localizedDescription
        let name = "\\(RCTFatalExceptionName): \\(description)"
        let stack = nsError.userInfo[RCTJSStackTraceKey] as? [[String: Any]]
        let reason = RCTFormatError(description, stack, 175)
        var userInfo = nsError.userInfo
        userInfo["RCTUntruncatedMessageKey"] = RCTFormatError(description, stack, 0)
        NSException(name: NSExceptionName(name), reason: reason, userInfo: userInfo).raise()
      }
    }

    RCTSetFatalExceptionHandler { exception in
      if let exception {
        T3CrashLog.persistNativeFatal(
          message: exception.reason ?? exception.name.rawValue,
          name: exception.name.rawValue,
          stack: T3CrashLog.formatExceptionStack(exception),
          extra: nil,
          source: "rct-fatal-exception"
        )
      }
      if let previousException {
        previousException(exception)
      } else {
        exception?.raise()
      }
    }
  }
`;

function ensureImport(contents) {
  if (contents.includes("import T3NativeControls")) {
    return contents;
  }
  if (contents.includes("import ReactAppDependencyProvider")) {
    return contents.replace(
      "import ReactAppDependencyProvider",
      `import ReactAppDependencyProvider\n${IMPORT_LINE}`,
    );
  }
  if (contents.includes("import React\n")) {
    return contents.replace("import React\n", `import React\n${IMPORT_LINE}\n`);
  }
  return `${IMPORT_LINE}\n${contents}`;
}

function ensureInstallCall(contents) {
  if (contents.includes(INSTALL_CALL)) {
    return contents;
  }
  const replaced = contents.replace(
    /(didFinishLaunchingWithOptions[^{]*\{\n)/,
    `$1    // t3code: capture RCTFatal message/stack before JS can die.\n    ${INSTALL_CALL}\n\n`,
  );
  if (replaced === contents) {
    throw new Error("withIosCrashLog: could not find didFinishLaunchingWithOptions body");
  }
  return replaced;
}

function ensureFatalHandlerMethod(contents) {
  if (contents.includes(METHOD_MARKER) && contents.includes(FLAG_MARKER)) {
    return contents;
  }
  if (contents.includes("// Linking API")) {
    return contents.replace("// Linking API", `${FATAL_HANDLER_METHOD}\n  // Linking API`);
  }
  // Fallback: insert before ReactNativeDelegate class.
  if (contents.includes("class ReactNativeDelegate")) {
    return contents.replace(
      "class ReactNativeDelegate",
      `${FATAL_HANDLER_METHOD}\n}\n\nclass ReactNativeDelegate`,
    );
  }
  throw new Error("withIosCrashLog: could not find insertion point for fatal handler method");
}

module.exports = function withIosCrashLog(config) {
  return withAppDelegate(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "swift") {
      throw new Error("The iOS crash log plugin requires a Swift AppDelegate.");
    }

    let contents = nextConfig.modResults.contents;
    contents = ensureImport(contents);
    contents = ensureInstallCall(contents);
    contents = ensureFatalHandlerMethod(contents);
    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
