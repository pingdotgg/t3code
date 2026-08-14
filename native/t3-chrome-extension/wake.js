// Wake the MV3 service worker on navigation so connectNative can run.
chrome.runtime.sendMessage({ type: "t3-wake" }).catch(() => {});
