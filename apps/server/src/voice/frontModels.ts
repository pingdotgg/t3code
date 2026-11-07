import type { ModelFile } from "../speech/SpeechModelStore.ts";

export type FrontModelEntry = ModelFile & {
  readonly name: string;
  readonly description: string;
};

/** Managed front models, pinned like the speech catalog. Measurements: see the PR that added them. */
const FRONT_MODELS: readonly FrontModelEntry[] = [
  {
    id: "unsloth/gemma-4-E2B-it-GGUF",
    revision: "0314792d7f1f7e229411f620751375812bb9faf2",
    filename: "gemma-4-E2B-it-Q4_K_M.gguf",
    size: 3_106_738_272,
    sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
    name: "Gemma 4 E2B",
    description: "Best decisions for its speed",
  },
  {
    id: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    revision: "a06e946bb6b655725eafa393f4a9745d460374c9",
    filename: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    size: 2_497_281_120,
    sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    name: "Qwen3 4B Instruct",
    description: "Larger, steadier task wording",
  },
  {
    id: "unsloth/Qwen3-1.7B-GGUF",
    revision: "d7f544eead698dbd1f15126ef60b45a1e1933222",
    filename: "Qwen3-1.7B-Q4_K_M.gguf",
    size: 1_107_409_472,
    sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
    name: "Qwen3 1.7B",
    description: "Smallest download, fastest on a CPU",
  },
];

export const getFrontModel = (modelId: string) =>
  FRONT_MODELS.find((model) => model.id === modelId);
