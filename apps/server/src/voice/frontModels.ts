import type { ModelFile } from "../speech/SpeechModelStore.ts";

export type FrontModelEntry = ModelFile & {
  readonly name: string;
  readonly description: string;
};

// Chosen on 50 voice-style prompts: Qwen3 4B made no harmful calls (only note vs delegate), while
// Gemma 4 E2B answered noise and Llama 3.2 3B and Qwen3 1.7B answered project questions themselves.
const FRONT_MODELS: readonly FrontModelEntry[] = [
  {
    id: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    revision: "a06e946bb6b655725eafa393f4a9745d460374c9",
    filename: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    size: 2_497_281_120,
    sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    name: "Qwen3 4B Instruct",
    description: "Best choices; wants a GPU",
  },
  {
    id: "unsloth/Qwen3-1.7B-GGUF",
    revision: "d7f544eead698dbd1f15126ef60b45a1e1933222",
    filename: "Qwen3-1.7B-Q4_K_M.gguf",
    size: 1_107_409_472,
    sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
    name: "Qwen3 1.7B",
    description: "Faster on a CPU, more wrong calls",
  },
];

export const getFrontModel = (modelId: string) =>
  FRONT_MODELS.find((model) => model.id === modelId);
