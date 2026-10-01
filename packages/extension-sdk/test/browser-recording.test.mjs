import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as catalogue from "../dist/catalogue.js";

NodeTest.test("host-local capture does not advertise a phantom brokered recording stream", () => {
  NodeAssert.equal(catalogue.BROWSER_CAPTURE_ADDITIONS, undefined);
});

NodeTest.test("annotation capture uses an independent minimum version", () => {
  NodeAssert.equal(catalogue.BROWSER_ANNOTATION_MIN_VERSION, "1.3.0");
});

NodeTest.test("recording and artifact actions have independent installable grants", () => {
  for (const grant of ["t3.browser/recording", "t3.browser/artifact-actions"])
    NodeAssert.ok(catalogue.HOST_CAPABILITY_GRANTS.includes(grant));
  NodeAssert.deepEqual(catalogue.BROWSER_RECORDING_REQUIRED_GRANTS, [
    "t3.browser/sessions",
    "t3.browser/capture",
    "t3.browser/recording",
  ]);
});

NodeTest.test(
  "recording grants describe video recording and saved recording actions honestly",
  () => {
    NodeAssert.equal(
      catalogue.HOST_CAPABILITY_GRANT_DESCRIPTIONS?.["t3.browser/recording"],
      "Record the browser panel as video",
    );
    NodeAssert.equal(
      catalogue.HOST_CAPABILITY_GRANT_DESCRIPTIONS?.["t3.browser/artifact-actions"],
      "Reveal saved recordings and copy their file paths",
    );
  },
);

NodeTest.test(
  "recording requires its minimum version and refuses older or incomplete hosts",
  () => {
    NodeAssert.equal(catalogue.BROWSER_RECORDING_MIN_VERSION, "1.2.0");
    const capture = {
      version: "1.2.0",
      startRecording() {},
      stopRecording() {},
      subscribeRecording() {},
      recordingSupport: { supported: true },
    };
    NodeAssert.equal(catalogue.resolveBrowserRecording(capture), capture);
    for (const version of ["1.1.0", "2.0.0", "invalid"])
      NodeAssert.equal(catalogue.resolveBrowserRecording({ ...capture, version }), null);
    NodeAssert.equal(
      catalogue.resolveBrowserRecording({ ...capture, stopRecording: undefined }),
      null,
    );
    NodeAssert.equal(catalogue.resolveBrowserRecording(undefined), null);
  },
);
