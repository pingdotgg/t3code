import {
  EditImageInput,
  GenerateImageInput,
  GenerateImageResult,
  ImageGenerationUnavailableError,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ImageGenerationService } from "../../../imageGeneration/ImageGenerationService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ImageGenerationService];

export const GenerateImageTool = Tool.make("generate_image", {
  description:
    "Generate an image with T3 Code's image integration and save it to the T3 image library. Use this instead of shelling out to Codex or Grok. Aspect ratio defaults to auto. Optional quality and resolution: quality is auto/low/medium/high, resolution is 1k or 2k. Returns the saved absolute path. Copy into the project only when the user wants the asset in the repo.",
  parameters: GenerateImageInput,
  success: GenerateImageResult,
  failure: ImageGenerationUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Generate image")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const EditImageTool = Tool.make("edit_image", {
  description:
    "Edit an existing image with T3 Code's image integration. Pass a T3 image id from generate_image or an absolute path. Saves the result to the T3 image library and returns the new path.",
  parameters: EditImageInput,
  success: GenerateImageResult,
  failure: ImageGenerationUnavailableError,
  dependencies,
})
  .annotate(Tool.Title, "Edit image")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const ImageGenerationToolkit = Toolkit.make(GenerateImageTool, EditImageTool);
