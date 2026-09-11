import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getComposerProviderState } from "./composerProviderState";

// The composer derives the attach button's disabled state from the active
// model's resolved input capabilities:
//
//   attachButtonDisabled = !inputCapabilities.images && !inputCapabilities.files
//
// There is no extractable helper for this one-liner policy; it lives inline in
// ChatComposer. These tests exercise the real capability-resolution path
// (ModelCapabilities -> getComposerProviderState -> inputCapabilities) across
// the matrix that drives the disabled flag, so a regression in capability
// resolution surfaces as a wrong button state rather than a silent miscompile.

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("devin");
const MODEL = "test-model";

function modelWith(caps: ModelCapabilities): ReadonlyArray<ServerProviderModel> {
  return [{ slug: MODEL, name: MODEL, isCustom: false, capabilities: caps }];
}

function attachButtonDisabled(inputCapabilities: {
  images: boolean;
  audio: boolean;
  files: boolean;
}): boolean {
  return !inputCapabilities.images && !inputCapabilities.files;
}

describe("attach button disabled derivation", () => {
  it("disables the button when the model accepts neither images nor files", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith({ optionDescriptors: [], inputImages: false, inputFiles: false }),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.inputCapabilities).toEqual({ images: false, audio: true, files: false });
    expect(attachButtonDisabled(state.inputCapabilities)).toBe(true);
  });

  it("keeps the button enabled when only images are unsupported (files still accepted)", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith({ optionDescriptors: [], inputImages: false }),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.inputCapabilities).toEqual({ images: false, audio: true, files: true });
    expect(attachButtonDisabled(state.inputCapabilities)).toBe(false);
  });

  it("keeps the button enabled when only files are unsupported (images still accepted)", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith({ optionDescriptors: [], inputFiles: false }),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.inputCapabilities).toEqual({ images: true, audio: true, files: false });
    expect(attachButtonDisabled(state.inputCapabilities)).toBe(false);
  });

  it("keeps the button enabled when the model declares no capability restrictions", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith({ optionDescriptors: [] }),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.inputCapabilities).toEqual({ images: true, audio: true, files: true });
    expect(attachButtonDisabled(state.inputCapabilities)).toBe(false);
  });

  it("keeps the button enabled when capabilities are entirely absent (permissive default)", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith({}),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.inputCapabilities).toEqual({ images: true, audio: true, files: true });
    expect(attachButtonDisabled(state.inputCapabilities)).toBe(false);
  });

  it("disables the button when images and files are both false but audio is supported", () => {
    // Audio support must not keep the attach button alive — the single attach
    // button only handles images and files.
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith({ optionDescriptors: [], inputImages: false, inputFiles: false }),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.inputCapabilities.audio).toBe(true);
    expect(attachButtonDisabled(state.inputCapabilities)).toBe(true);
  });
});
