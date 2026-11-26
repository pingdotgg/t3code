// @effect-diagnostics nodeBuiltinImport:off - worker parallelism comes from the host's CPU count.
import * as NodeOS from "node:os";
import {
  SpeechSynthesisError,
  type SpeechSynthesisCatalog,
  type SpeechSynthesisRequest,
} from "@t3tools/contracts";
import {
  AUDIO_CPP_ESPEAK_DATA,
  AUDIO_CPP_VERSION,
  audioCppRuntime,
  type AudioCppRuntime,
} from "@t3tools/audio-cpp";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import type { SpeechSynthesisPart } from "./CloudSpeech.ts";
import { loadLocalSynthesisModel, type LocalSynthesisModel } from "./localSynthesisWorker.ts";
import { supertonicText } from "./synthesisAudio.ts";

/** A preset the model names itself, one it reads from its own file, or a speaker it imitates. */
type LocalVoice = {
  readonly id: string;
  /** For ids that read poorly, such as `Uncle_Fu`. */
  readonly name?: string;
  readonly file?: SpeechModelStore.ModelFile;
  /** A recording of the speaker, and what they say in it. */
  readonly clip?: { readonly file: SpeechModelStore.ModelFile; readonly text: string };
};

type LocalModel = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly recommended?: boolean;
  readonly file: SpeechModelStore.ModelFile;
  /** Whether the model honors the speed option; clients speed up playback for the rest. */
  readonly appliesSpeed: boolean;
  readonly voices: readonly LocalVoice[];
  /** The languages its voices speak, as ISO 639-1 codes. */
  readonly languages: readonly string[];
  /** eSpeak-ng data the model phonemizes with, installed and removed with it. */
  readonly espeakData?: SpeechModelStore.ModelFile;
  /** Cleanup the model's reference implementation applies before it reads text. */
  readonly speakable?: (text: string) => string;
  /** The request option that carries a clip's transcript, for models that want one. */
  readonly clipText?: "reference_text" | "prompt_text";
  /** False for a model with one voice and no option to choose it. */
  readonly voiceOption?: false;
  /** Request options the model needs beyond voice and speed. */
  readonly options?: Readonly<Record<string, string>>;
  /** False for a model that rejects a language in the request, taking it from the voice. */
  readonly takesLanguage?: false;
};

const AUDIO_CPP_GGUF = "audio-cpp/audio.cpp-gguf";
const GGUF_REVISION = "7a103b33f04120535bdfe97b5f65b79d3c90d708";
// Each Pocket TTS language ships its own weights and voice files, under the same voice names.
const pocketModel = (
  language: string,
  code: string,
  name: string,
  size: number,
  sha256: string,
  voices: ReadonlyArray<readonly [voice: string, size: number, sha256: string]>,
): LocalModel => ({
  id: `pocket-tts-${language}`,
  name,
  description: "Small, and fast without a GPU.",
  file: {
    id: AUDIO_CPP_GGUF,
    revision: GGUF_REVISION,
    filename: `PocketTTS-GGUF/${language}/pocket-tts-${language}-q8_0.gguf`,
    size,
    sha256,
  },
  appliesSpeed: false,
  languages: [code],
  voices: voices.map(([voice, voiceSize, voiceSha256]) => ({
    id: voice[0]!.toUpperCase() + voice.slice(1),
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: `pocket-tts-${language}-${voice}.safetensors`,
      url: `https://huggingface.co/${AUDIO_CPP_GGUF}/resolve/${GGUF_REVISION}/PocketTTS-GGUF/${language}/embeddings/${voice}.safetensors`,
      size: voiceSize,
      sha256: voiceSha256,
    },
  })),
});

const gguf = (filename: string, size: number, sha256: string): SpeechModelStore.ModelFile => ({
  id: AUDIO_CPP_GGUF,
  revision: GGUF_REVISION,
  filename,
  size,
  sha256,
});

// LibriTTS-R recordings (CC BY 4.0), for models that imitate a speaker instead of naming voices.
const VOICE_CLIP_RELEASE = "t3-2026.11.17";
const voiceClip = (id: string, name: string, size: number, sha256: string, text: string) => {
  const filename = `audio-${VOICE_CLIP_RELEASE}-voice-${id}.wav`;
  return {
    id,
    name,
    clip: {
      file: {
        id: "pingdotgg/audio.cpp",
        revision: VOICE_CLIP_RELEASE,
        filename,
        url: `https://github.com/pingdotgg/audio.cpp/releases/download/${VOICE_CLIP_RELEASE}/${filename}`,
        size,
        sha256,
      },
      text,
    },
  } satisfies LocalVoice;
};
const CLIP_VOICES = [
  voiceClip(
    "female-1",
    "Female 1",
    339_918,
    "f7dd6a3e1bb24b54c47aab237c88d9eb7d883c4c6ae4d3f8a1e64b1bbbc33392",
    "As yet, they had been unable to attempt any fancy riding with their ponies, owing to the rugged nature of the country through which they had been journeying.",
  ),
  voiceClip(
    "male-1",
    "Male 1",
    403_278,
    "aeb2b5c256c2511ee25a3d6f4a01f6a0f91bb9d31bb2f836bd49c11f69582432",
    "The heavy, lumpy sea strained her cordage, her timbers creaked, and she labored painfully in the trough of the sea.",
  ),
  voiceClip(
    "female-2",
    "Female 2",
    443_598,
    "5943b56b205a11fbf7118cb044554633ef915f7f823c271a2bb6cc769443ed80",
    "So soon as the growth of the child had rendered him fitted for it, he had brought him out on the stage, that is, he had produced him in front of the van.",
  ),
  voiceClip(
    "male-2",
    "Male 2",
    391_758,
    "0c4e4efa6120dfa1391e968e8fe63207d3499159bf8bc523aa98a259f07ab884",
    "The Reverend Mr. North, in this cool atmosphere, seemed to recover himself, and conversation progressed with some sprightliness.",
  ),
];

const capitalized = (id: string) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) });
// Kitten TTS 2 names some presets in camel case, such as `AirportAnnouncer`.
const KITTEN_2_VOICES = [
  "Bella",
  "Jasper",
  "Luna",
  "Bruno",
  "Rosie",
  "Hugo",
  "Kiki",
  "Leo",
  "Matthew",
  "Elliot",
  "Willow",
  "Dolores",
  "Victor",
  "Dante",
  "Alfred",
  "Saoirse",
  "Claire",
  "Raven",
  "Marcus",
  "Herbert",
  "Diana",
  "Laurence",
  "Maeve",
  "Walter",
  "Edith",
  "Miles",
  "Grace",
  "Reginald",
  "Iris",
  "Frank",
  "Serena",
  "Julian",
  "Eleanor",
  "Otis",
  "Vincent",
  "Martha",
  "Sable",
  "Victoria",
  "Arabic",
  "Chinese",
  "French",
  "German",
  "Hindi",
  "Italian",
  "Portuguese",
  "Russian",
  "Spanish",
  "AirportAnnouncer",
  "ArabicChildSchool",
  "ArabicFalconer",
  "ArabicMother",
  "ArabicNews",
  "AudiobookNarratorFemale",
  "BoredTeenager",
  "CalmHostageNegotiator",
  "ChineseKidSpringFestival",
  "ChineseLivestreamSeller",
  "ChineseNewsCctv",
  "ChineseXianxiaMaster",
  "DutchBaker",
  "DutchGrandpaStory",
  "DutchWeatherPresenter",
  "FairytaleNarratorWhimsical",
  "FrenchDocumentary",
  "FrenchGrandmereRecette",
  "FrenchTeacher",
  "FrenchWaiter",
  "GermanKidBirthday",
  "GermanKneipe",
  "GermanProfessor",
  "GermanTrainAnnouncement",
  "GrandmaBedtimeStory",
  "GriefEulogy",
  "HindiBollywoodDrama",
  "HindiCollegeFriends",
  "HindiDadiKahani",
  "HindiYogaTeacher",
  "IndonesianNewsAnchor",
  "IndonesianTourGuide",
  "ItalianChildSchool",
  "ItalianFashionDesigner",
  "ItalianFootballFan",
  "ItalianGondolier",
  "ItalianNonnaKitchen",
  "ItalianOperaTenor",
  "JapaneseAnimeHeroine",
  "JapaneseGrandma",
  "JapaneseSalarymanApology",
  "JapaneseTrainConductor",
  "KoreanGrandpaAdvice",
  "KoreanKdramaConfession",
  "KoreanNewsAnchor",
  "LittleGirlExplaining",
  "NervousFirstDate",
  "NewsAnchorFemale",
  "PilotCabinAnnouncement",
  "PolishBabciaPierogi",
  "PolishMountainGuide",
  "PolishNewsAnchor",
  "PolishPoetryStudent",
  "PortugueseBeach",
  "PortugueseBusiness",
  "PortugueseFado",
  "PortugueseGrandpaFarm",
  "PortugueseKidFutebol",
  "PortugueseNewsAnchor",
  "RussianBabushka",
  "RussianFairyTale",
  "RussianHockeyCheer",
  "RussianLiteratureTeacher",
  "RussianSpaceControl",
  "RussianTaxiDriver",
  "SarcasticCoworker",
  "SchoolboyPresentation",
  "SpanishAbuela",
  "SpanishBreakupSad",
  "SpanishChildCuento",
  "SpanishNews",
  "SpanishTango",
  "TurkishFisherman",
  "TurkishGrandmaCooking",
  "TurkishNewsAnchor",
  "WeatherPresenterCheerful",
].map((id) => {
  const name = id.replaceAll(/(?<=[a-z])(?=[A-Z])/g, " ");
  return name === id ? { id } : { id, name };
});

// Japanese and Chinese Kokoro voices need the multilingual package's dictionaries.
const KOKORO_VOICES = [
  ...[
    "heart",
    "alloy",
    "aoede",
    "bella",
    "jessica",
    "kore",
    "nicole",
    "nova",
    "river",
    "sarah",
    "sky",
  ].map((name) => `af_${name}`),
  ...["adam", "echo", "eric", "fenrir", "liam", "michael", "onyx", "puck", "santa"].map(
    (name) => `am_${name}`,
  ),
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
  "ef_dora",
  "em_alex",
  "em_santa",
  "ff_siwis",
  "hf_alpha",
  "hf_beta",
  "hm_omega",
  "hm_psi",
  "if_sara",
  "im_nicola",
  "pf_dora",
  "pm_alex",
  "pm_santa",
];

// The first model is the default, and each model's first voice is its default.
const LOCAL_SYNTHESIS_MODELS: readonly LocalModel[] = [
  {
    id: "kokoro-82m",
    name: "Kokoro",
    description: "Natural voices, most of them English.",
    recommended: true,
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf",
      size: 189_550_976,
      sha256: "9a4ca6176460cdc8c7845b804c0bbe85a4791ee3ffff568a3fdadbb708c63f47",
    },
    appliesSpeed: true,
    voices: KOKORO_VOICES.map((id) => ({ id })),
    languages: ["en", "es", "fr", "hi", "it", "pt"],
    espeakData: {
      id: "pingdotgg/audio.cpp",
      revision: AUDIO_CPP_VERSION,
      ...AUDIO_CPP_ESPEAK_DATA,
    },
  },
  {
    id: "qwen3-tts-1.7b",
    name: "Qwen3-TTS 1.7B",
    description:
      "The most natural voices, and the most accurate. Needs a GPU and about 7 GB of memory.",
    recommended: true,
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
      size: 2_817_055_200,
      sha256: "c8ac3f94b6e73f137c0e7ecc9270bc8faec7a476ff799b87e48844d1d0987ac3",
    },
    appliesSpeed: false,
    // The model's own speakers, English first; each reads every language.
    voices: [
      { id: "Ryan" },
      { id: "Aiden" },
      { id: "Vivian" },
      { id: "Serena" },
      { id: "Uncle_Fu", name: "Uncle Fu" },
      { id: "Dylan" },
      { id: "Eric" },
      { id: "Ono_Anna", name: "Ono Anna" },
      { id: "Sohee" },
    ],
    languages: ["en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "supertonic-3",
    name: "Supertonic 3",
    description: "Fastest with a GPU.",
    file: {
      id: AUDIO_CPP_GGUF,
      revision: "ca0b203eb1bb87f333a7cfbad2d5f6672b4ccba7",
      filename: "Supertonic-3-GGUF/supertonic-3-f16.gguf",
      size: 312_785_732,
      sha256: "7a44c47d1f387e4fb163e2eed9615b58470c77e26ac8b2b1a6be49dfb8670899",
    },
    appliesSpeed: true,
    voices: ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].map((id) => ({ id })),
    // From the model card.
    languages: [
      "en",
      "ko",
      "ja",
      "ar",
      "bg",
      "cs",
      "da",
      "de",
      "el",
      "es",
      "et",
      "fi",
      "fr",
      "hi",
      "hr",
      "hu",
      "id",
      "it",
      "lt",
      "lv",
      "nl",
      "pl",
      "pt",
      "ro",
      "ru",
      "sk",
      "sl",
      "sv",
      "tr",
      "uk",
      "vi",
    ],
    speakable: supertonicText,
  },
  pocketModel(
    "english",
    "en",
    "Pocket TTS English",
    127_867_968,
    "3f71cf6a51f93c2f2e554e98970a3f49fb9a98d0c64bed5a815e65be3d2ff588",
    [
      ["alba", 6_194_424, "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845"],
      ["anna", 7_816_440, "5ea82f78db006c9fd34e32ddd5aae82674b5b32646097977436458d00af80dfa"],
      ["eve", 6_538_488, "ea9c2faf862a6c9d2cb61910fdf02842ae56940382cc8c1000fdb1b43269692b"],
      ["jane", 7_374_072, "37386227ca8ec5bf1b8e516c13d132ce5ff5437a304fe90129a1c62f41d9a008"],
      ["charles", 6_194_424, "299edc20182eeccfbf94e308626f259da4fbf339daa8d5905218f2b1774639b8"],
      ["george", 6_243_576, "0c1c6c57c55a98d81254b33728150c7776f40647fe95258d1a6c1a02780b5d02"],
      ["michael", 7_275_768, "8937f724ac4719b9aa51ea0ba1f18f9de0af7a663ad6263558266c1a53c9722d"],
      ["paul", 6_980_856, "ed7a019168f94dfe77009f1b0de59387abc6fbb0db954d38ce722ecb77da61aa"],
    ],
  ),
  pocketModel(
    "french",
    "fr",
    "Pocket TTS Français",
    128_117_408,
    "ae7e6d536c20245d216a7ec9404124cf67f913380bf41a6380c55d6ca9dbaef5",
    [
      ["alba", 6_244_152, "4c80b1438668290542068bbc9515abd2c267f4cc86764c6633fcde395d1b2681"],
      ["anna", 7_620_408, "7a7fae31e4b0e16102cb2514f96189cdb57c8403f5f7aba2b37aa942e2d03488"],
      ["eve", 6_145_848, "b642a43b786fb60571656814cc66f9c24f8a457ea9f727903ea97d647d5ceedb"],
      ["jane", 7_325_496, "1482685d8a1a22a7294df650f61293bab353445710e26a60ae057cbf4ad85221"],
      ["charles", 6_195_000, "956942f32745023f512ca99a45514648c8bbf4a4edc5bb5fdcb7c1a5dd5fbf97"],
      ["george", 5_900_088, "b7513caf686418ec303dfd87dc6ddbcc020df9bf5964cb4afcd0b72b602afa6f"],
      ["michael", 7_128_888, "7dc7c44c71e514fcec8203a310676c410b3a68280dd52f6d60c424d51a8b638a"],
      ["paul", 6_833_976, "85d2f623d5de93dbc33b56f7cbdb90bfaf100c1a7a0958848326223bc7cda5ed"],
    ],
  ),
  pocketModel(
    "german",
    "de",
    "Pocket TTS Deutsch",
    127_868_448,
    "d99a966c42026dbe119863ad8a8c96ddd3c8d2e800dfe2ab75a0caa579293268",
    [
      ["alba", 6_194_424, "b5a1933388634f63f0f709d3139f64d3c78281160d4a3bf6ea3bd1abc3ba94b6"],
      ["anna", 7_816_440, "6aa8e46421e4a8a602976918ed407fde55e7603b313acbe2e4432905b8bee7bc"],
      ["eve", 6_538_488, "223f60a58a28236b27ca361e01f182fb919e72f0e3dceffb3bf18f006a0d0097"],
      ["jane", 7_374_072, "4572c0d06ce058ecb4f54d5059dcb872b3084d0cef95958faaf73bd4e1ccaf28"],
      ["charles", 6_194_424, "c8bbc4a0e46cd0f16df2aaed7dfe811a0ca2d93799837ca4200851db906530b4"],
      ["george", 6_243_576, "bb0ecc9d5524fe64102f44c190be74d2dbee33bcf51f44dbb16e9b6b046496e1"],
      ["michael", 7_275_768, "6a491e111f277fab05bc05696691d621fd0847ae3b3be9271beb64453970d0f2"],
      ["paul", 6_980_856, "3f74b464af87e9f8ee59895d806d6a2a05b5e7c345491d03177a92bc66a0eede"],
    ],
  ),
  pocketModel(
    "italian",
    "it",
    "Pocket TTS Italiano",
    127_868_704,
    "aa25eb6c0d73fa90a26c07ed5453f44c321ff483b33e96e5c3693b6f76ef9149",
    [
      ["alba", 6_194_424, "7d2bd2e5df41e5ede229857bcc2b56d41856725465260c330ba847e8a945442c"],
      ["anna", 7_816_440, "2d1bb064780b6b3c4a77a336c51335fde6dd07b506ccf329d2d0872ad6327c5f"],
      ["eve", 6_538_488, "6bd49ded51178b6a388bfad57360d4f3b795f89fa7155923efbd968405f01c9f"],
      ["jane", 7_374_072, "56bcf13e73c2143ab431e59be4d4b67ef0cb086ce63626f290a5edcbd1c3fa7f"],
      ["charles", 6_194_424, "1e4b6dafd17e0bb4489590f821f7083b598bd0dbe6d93bcabc8b72bb383881d5"],
      ["george", 6_243_576, "c54fd34b252255f61f007fda923d8cb33b3f960b4806335ace0a74c2227a878d"],
      ["michael", 7_275_768, "3a52c4eb205affd8da5b8d8d2e384328b258f6652f2ad170311bb28f5cdab714"],
      ["paul", 6_980_856, "c0a1913b9bf224d61d15562c3f1ff778e6ecfb77432c998ce785b3c04a19d9a0"],
    ],
  ),
  pocketModel(
    "portuguese",
    "pt",
    "Pocket TTS Português",
    127_869_632,
    "e6e76fde1770586b11fab5a7d4fa07006d911098718991e242ca6006bd0513cd",
    [
      ["alba", 6_194_424, "855b277ffa0e1f1600acacdb72f4e8609af7db7bbb5236dd904d1472c27541d2"],
      ["anna", 7_816_440, "70ef78480c1d90f502826c10b0512effa34262453e22a76d5992d5fa1e8182bb"],
      ["eve", 6_538_488, "c3d3526bdf0d4f82a3e6cc8bca62148a20c69bbe6596fb72920478688f378488"],
      ["jane", 7_374_072, "de8f3516290a8f554785366cd2ce5dac1ad6abf694b6d37a41553b092eeb508e"],
      ["charles", 6_194_424, "e643bddfba4c1c302f0589c09a18ac553af9fa2c7e82109e12a1a89225dd06bb"],
      ["george", 6_243_576, "f727f2820a343dc8cb0f867478e8feae9ecc8da41d6a84e6e051f1c192d20bb4"],
      ["michael", 7_275_768, "d9348313f6e9d7badd420cffac11a59dc5767eeeccc7a679f8cfaaffecce7f2c"],
      ["paul", 6_980_856, "ce48b67d732704f38985b38f5d5dea54175fa5bca795379cad0cffd55e534668"],
    ],
  ),
  pocketModel(
    "spanish",
    "es",
    "Pocket TTS Español",
    127_869_504,
    "d2645064c191d0b9b8daf6d24d2b8a310d89f694c9b3523c1258bc9455adcaff",
    [
      ["alba", 6_194_424, "694be334ed6dda508b125e22a6ae480036d1c99923cccd92a643a348867f3235"],
      ["anna", 7_816_440, "fe964cdad79e8c2c0d2ca30bc9dc8479c6f38b45b77512975a6e272109367337"],
      ["eve", 6_538_488, "3fdb6a2ddd06f339b015ec90aea2ea004c260fe463c9526e020249b307096a41"],
      ["jane", 7_374_072, "1bf9bfe3172412c44d0c7227e49eeb40b060f6833e2f6f365f0bbcde757afd09"],
      ["charles", 6_194_424, "d620942926b0a30dcf002212221c89bb4f3b8b9b9bd2cc7d034c5e1c792a675f"],
      ["george", 6_243_576, "da140d63300c46c31b49ec26402a0b4efed5d773da8310cf4ccca115853cdc87"],
      ["michael", 7_275_768, "ca3dfdaff6a2bf70ef9b2ab69bc66dce6d16fb06d4d7473be92610d3e43e9e15"],
      ["paul", 6_980_856, "fcd677f0459352f7cdf62d7a1424a663bd49fc8921fb2b8e346ef9b45c92dd04"],
    ],
  ),
  {
    id: "m5-tts-50m",
    name: "M5-TTS",
    description: "One voice, made for Chinese. Smaller than Qwen3-TTS.",
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "M5-TTS-GGUF/m5-tts-50m-customvoice-q8_0.gguf",
      size: 938_645_536,
      sha256: "e73662b226ffcb3493e6d627fcdc6b53ee43d965e48e5490f99b7dd6c1fd82aa",
    },
    appliesSpeed: false,
    voices: [{ id: "1" }],
    languages: ["zh", "en", "de", "fr", "ja", "ko"],
  },
  {
    id: "qwen3-tts-0.6b",
    name: "Qwen3-TTS 0.6B",
    description: "Natural recorded voices, smaller and faster than Qwen3-TTS 1.7B. Needs a GPU.",
    recommended: true,
    file: gguf(
      "Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf",
      1_991_217_728,
      "c7d0e6c9485a25ae1f6a4c0796f0023230a0051c44cbd2bd05d73770f2cce637",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    clipText: "reference_text",
    languages: ["en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "piper-lessac",
    name: "Piper",
    description: "One English voice. Tiny, and fast on any computer.",
    file: gguf(
      "Piper-TTS-GGUF/piper-en-us-lessac-medium-orig.gguf",
      62_662_016,
      "12432fab389024e7f839fbc0d989afba46e74bf0d2fa75495642b3ae44a4b093",
    ),
    appliesSpeed: true,
    voices: [{ id: "lessac", name: "Lessac" }],
    voiceOption: false,
    languages: ["en"],
    espeakData: {
      id: "pingdotgg/audio.cpp",
      revision: AUDIO_CPP_VERSION,
      ...AUDIO_CPP_ESPEAK_DATA,
    },
  },
  {
    id: "inflect-micro-v2",
    name: "Inflect Micro",
    description: "One English voice. Tiny, and fast on any computer.",
    file: gguf(
      "Inflect-Micro-v2-GGUF/inflect-micro-v2-orig.gguf",
      72_082_592,
      "9d01cfe6a94592f544f8dde273d89c9ec5cd0fd4720c2a46becbf517bba06b1c",
    ),
    appliesSpeed: true,
    voices: [{ id: "default", name: "Default" }],
    voiceOption: false,
    languages: ["en"],
    espeakData: {
      id: "pingdotgg/audio.cpp",
      revision: AUDIO_CPP_VERSION,
      ...AUDIO_CPP_ESPEAK_DATA,
    },
  },
  {
    id: "kitten-tts-mini",
    name: "Kitten TTS Mini",
    description: "Eight English voices. Small, and fast without a GPU.",
    file: gguf(
      "KittenTTS-GGUF/kitten-tts-mini-0.8-orig.gguf",
      302_167_648,
      "485a50101b6c16e98c842f231780789d54136ffb07a6cacb33dc0735103274d7",
    ),
    takesLanguage: false,
    appliesSpeed: true,
    voices: ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"].map((id) => ({
      id,
    })),
    languages: ["en"],
    espeakData: {
      id: "pingdotgg/audio.cpp",
      revision: AUDIO_CPP_VERSION,
      ...AUDIO_CPP_ESPEAK_DATA,
    },
  },
  {
    id: "pocket-tts-small",
    name: "Pocket TTS Small",
    description: "One English voice. The smallest model, and fast on any computer.",
    file: gguf(
      "PocketTTS-Small-GGUF/english-18m-refl/english-18m-refl-f32.gguf",
      111_809_536,
      "f19bbf172c443ce63aaf22ce2d2fbabf45726cc48694c3c4904e8ec4a8661a3c",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: [
      {
        id: "Alba",
        file: {
          id: AUDIO_CPP_GGUF,
          revision: GGUF_REVISION,
          filename: "pocket-tts-small-alba.safetensors",
          url: `https://huggingface.co/${AUDIO_CPP_GGUF}/resolve/${GGUF_REVISION}/PocketTTS-Small-GGUF/english-18m-refl/embeddings/alba.safetensors`,
          size: 4_163_992,
          sha256: "e1aa12e17245952e044853867deef5e77ec4474df119cbeefa4ed2a3d878a7b1",
        },
      },
    ],
    languages: ["en"],
  },
  {
    id: "neutts-2e",
    name: "NeuTTS 2E",
    description: "Nine English voices.",
    file: gguf(
      "NeuTTS-2E-GGUF/neutts-2e-orig.gguf",
      3_016_181_288,
      "fb1b437f6ae9ba005930a38977573f994bc08290f3b16ee6ca99028a2aeb402d",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: ["emily", "dave", "greta", "jo", "juliette", "mateo", "paul", "sophie", "steven"].map(
      capitalized,
    ),
    languages: ["en"],
  },
  {
    id: "chatterbox-turbo",
    name: "Chatterbox Turbo",
    description: "One English voice.",
    file: gguf(
      "Chatterbox-Turbo-GGUF/chatterbox-turbo-q8_0.gguf",
      699_102_368,
      "acf02bed2b9ac94e271a01f556526818161a28009120f2337b9e8e10035c42b6",
    ),
    appliesSpeed: false,
    voices: [{ id: "default", name: "Default" }],
    voiceOption: false,
    languages: ["en"],
  },
  {
    id: "kitten-tts-2",
    name: "Kitten TTS 2",
    description: "Over 100 voices in 16 languages; each voice speaks its own.",
    file: gguf(
      "KittenTTS2-GGUF/kitten-tts2-20261021-q4_0.gguf",
      2_638_763_488,
      "bbbef13230061a886adb0c38eecc84a4297ed8d965d3f014ac08f22f1c0f8658",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: KITTEN_2_VOICES,
    languages: [
      "en",
      "ar",
      "zh",
      "fr",
      "de",
      "hi",
      "it",
      "pt",
      "ru",
      "es",
      "nl",
      "id",
      "ja",
      "ko",
      "pl",
      "tr",
    ],
  },
  {
    id: "voxtral-4b",
    name: "Voxtral 4B",
    description: "20 voices in 9 languages. Needs a GPU. For non-commercial use only.",
    file: gguf(
      "Voxtral-4B-TTS-2603-GGUF/voxtral-4b-tts-2603-q8_0.gguf",
      4_722_918_208,
      "46eca2bfc66c89c415b66995d3544e91dea3320c93765ec0596f5c616354972d",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: [
      "casual_female",
      "casual_male",
      "cheerful_female",
      "neutral_female",
      "neutral_male",
      "fr_female",
      "fr_male",
      "es_female",
      "es_male",
      "de_female",
      "de_male",
      "it_female",
      "it_male",
      "pt_female",
      "pt_male",
      "nl_female",
      "nl_male",
      "ar_male",
      "hi_female",
      "hi_male",
    ].map((id) => {
      const [first = "", ...rest] = id.split("_");
      const lead =
        first.length === 2 ? first.toUpperCase() : first[0]!.toUpperCase() + first.slice(1);
      return { id, name: [lead, ...rest].join(" ") };
    }),
    languages: ["en", "fr", "es", "de", "it", "pt", "nl", "ar", "hi"],
  },
  {
    id: "kugelaudio-0",
    name: "KugelAudio",
    description: "Four voices in 23 languages. Needs a GPU.",
    file: gguf(
      "KugelAudio-0-Open-GGUF/kugelaudio-0-open-q4_k.gguf",
      5_732_997_442,
      "38a79cf4ffdcdeed69dc05d6350fc88042f951f952924799f59a0b93bc3895e9",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: [
      { id: "default", name: "Default" },
      { id: "clear", name: "Clear" },
      { id: "english_female", name: "English female" },
      { id: "english_male", name: "English male" },
    ],
    languages: [
      "en",
      "de",
      "fr",
      "es",
      "it",
      "pt",
      "nl",
      "pl",
      "ru",
      "uk",
      "cs",
      "ro",
      "hu",
      "sv",
      "da",
      "fi",
      "no",
      "el",
      "bg",
      "sk",
      "hr",
      "sr",
      "tr",
    ],
  },
  {
    id: "magpie-tts",
    name: "Magpie TTS",
    description: "Three voices in 11 languages. Slow; needs a fast GPU.",
    file: gguf(
      "MagpieTTS-Multilingual-357M-GGUF/magpie-tts-multilingual-357m-q8_0.gguf",
      1_562_142_912,
      "c762503a80f9af75db33379763b923c5c8a00ca79374e1e0d4051e6d68151377",
    ),
    appliesSpeed: false,
    voices: [{ id: "Sofia" }, { id: "Jason" }, { id: "0", name: "Default" }],
    languages: ["en", "de", "es", "fr", "it", "pt", "zh", "hi", "ko", "vi", "ar"],
  },
  {
    id: "plapre-3",
    name: "Plapre 3",
    description: "Five Danish voices.",
    file: gguf(
      "Plapre-3-GGUF/plapre-3-bf16.gguf",
      1_145_069_888,
      "8baa6069d5cd81bc01bfc039bfcb7c4b7406e659157b3c768fa2bc839fdfc9a1",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: ["tor", "ida", "liv", "ask", "kaj"].map(capitalized),
    languages: ["da"],
  },
  {
    id: "qwen3-tts-1.7b-base",
    name: "Qwen3-TTS 1.7B Base",
    description: "Qwen3-TTS 1.7B, reading in recorded voices. Needs a GPU.",
    file: gguf(
      "Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf",
      2_695_186_240,
      "92641a8022d521efd79a5db45e952589b3f2b781680f9abfcf26f075d37b86c6",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    clipText: "reference_text",
    languages: ["en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "cosyvoice-3",
    name: "CosyVoice 3",
    description: "Recorded voices in 9 languages. Needs a GPU.",
    file: gguf(
      "CosyVoice3-GGUF/cosyvoice3-q8_0.gguf",
      2_257_658_336,
      "d13bd731ead92d6d514d5749d9b59ea1b3ae735569fa46978250caaf5c983133",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: CLIP_VOICES,
    clipText: "reference_text",
    languages: ["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"],
  },
  {
    id: "moss-tts-nano",
    name: "MOSS-TTS Nano",
    description: "Recorded voices, for Chinese and English. Small and fast.",
    file: gguf(
      "MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-q8_0.gguf",
      193_343_328,
      "823b0de64f01f1ee9a168356c1199be500d71ec2f769f0183b416c9e6dbc0abc",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    // The default cap cuts off a clone partway through a long sentence.
    options: { max_tokens: "1000" },
    languages: ["zh", "en"],
  },
  {
    id: "voxcpm-0.5b",
    name: "VoxCPM 0.5B",
    description: "Recorded voices, for Chinese and English.",
    file: gguf(
      "VoxCPM1-GGUF/voxcpm-0.5b-q8_0-audiovae-f16.gguf",
      847_888_768,
      "c5cd54e0b011a1f5c43cce41f7deb24d2dfbd74b635fcc6b5229b57a4ec37d11",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    clipText: "prompt_text",
    languages: ["zh", "en"],
  },
  {
    id: "voxcpm-2",
    name: "VoxCPM 2",
    description: "Recorded voices, for Chinese and English. Needs a GPU.",
    file: gguf(
      "VoxCPM2-GGUF/voxcpm2-q8_0.gguf",
      2_955_007_488,
      "8df1faf274e1bdeedef1fd9ddd6aba6632536f66f2e080991d2352af35ceef72",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    clipText: "prompt_text",
    // Retrying a bad take cannot work once its audio has streamed.
    options: { retry_badcase: "false" },
    languages: ["zh", "en"],
  },
  {
    id: "chatterbox",
    name: "Chatterbox",
    description: "Recorded voices in 19 languages. Slow; needs a fast GPU.",
    file: gguf(
      "Chatterbox-GGUF/chatterbox-q8_0.gguf",
      2_088_399_204,
      "45d71d8d248ba831014813bbbbba74c7d786dd9447c02090fe05c44344f69453",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    languages: [
      "en",
      "ar",
      "da",
      "de",
      "el",
      "es",
      "fi",
      "fr",
      "hi",
      "it",
      "ko",
      "ms",
      "nl",
      "no",
      "pl",
      "pt",
      "sv",
      "sw",
      "tr",
    ],
  },
  {
    id: "index-tts-2.5",
    name: "IndexTTS 2.5",
    description: "Recorded voices in 5 languages. Slow to start; needs a fast GPU.",
    file: gguf(
      "IndexTTS2.5-GGUF/index-tts2_5-q8_0.gguf",
      3_502_960_096,
      "d1ab7b5c3f5ecf2bcd285753be76c7290b0a54939a76b7c39e8f886f80cf6b5c",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    languages: ["zh", "en", "ja", "es", "ar"],
  },
  {
    id: "omnivoice",
    name: "OmniVoice",
    description: "Recorded voices in hundreds of languages. For non-commercial use only.",
    file: gguf(
      "OmniVoice-GGUF/omnivoice-q8_0.gguf",
      1_350_296_096,
      "0e5a721edd1b08d9067ef66f40ded609a6b14f5a8445c703f9869736cabd350a",
    ),
    appliesSpeed: true,
    voices: CLIP_VOICES,
    clipText: "reference_text",
    languages: [
      "en",
      "zh",
      "ja",
      "ko",
      "de",
      "fr",
      "es",
      "it",
      "pt",
      "ru",
      "ar",
      "hi",
      "nl",
      "pl",
      "tr",
      "vi",
      "id",
      "th",
      "uk",
      "sv",
    ],
  },
  {
    id: "higgs-audio-v3",
    name: "Higgs Audio v3",
    description:
      "Recorded voices, for English and Chinese. Needs a GPU. For non-commercial research only.",
    file: gguf(
      "Higgs-Audio-v3-TTS-4B-GGUF/higgs-audio-v3-tts-4b-q8_0.gguf",
      5_095_359_136,
      "cfa5cc01adcd199dfcf1baf0f610aa474cda83418fd1802aa6defa82d956a0e4",
    ),
    appliesSpeed: false,
    voices: CLIP_VOICES,
    clipText: "reference_text",
    languages: ["en", "zh"],
  },
  {
    id: "breeze-tts-2",
    name: "Breeze TTS 2",
    description:
      "Recorded voices, for Taiwanese Mandarin and English. Needs a GPU. For non-commercial research only.",
    file: gguf(
      "Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf",
      5_079_670_336,
      "b17b89b1c21107c44e8d556ab0a856d7acd06bdd0c914e68e0e57f6e33f555a3",
    ),
    takesLanguage: false,
    appliesSpeed: false,
    voices: CLIP_VOICES,
    clipText: "reference_text",
    languages: ["zh", "en"],
  },
];

const modelFiles = (model: LocalModel) => [
  model.file,
  ...model.voices.flatMap((voice) => (voice.file ? [voice.file] : [])),
  // Several models share the same clips; an install fetches each once.
  ...model.voices.flatMap((voice) => (voice.clip ? [voice.clip.file] : [])),
  ...(model.espeakData ? [model.espeakData] : []),
];
const totalSize = (files: readonly SpeechModelStore.ModelFile[]) =>
  files.reduce((size, file) => size + file.size, 0);

const IDLE_UNLOAD_MS = 10 * 60_000;

export class LocalSynthesisInstallError extends Schema.TaggedError<LocalSynthesisInstallError>()(
  "LocalSynthesisInstallError",
  {
    reason: Schema.Literals([
      "unknown-model",
      "unsupported-platform",
      "busy",
      "not-found",
      "failed",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class LocalSpeechSynthesis extends Context.Service<
  LocalSpeechSynthesis,
  {
    readonly catalog: Effect.Effect<SpeechSynthesisCatalog>;
    /** Resolves when the install finishes or is cancelled; poll `catalog` for progress. */
    readonly download: (
      modelId: string,
    ) => Effect.Effect<SpeechSynthesisCatalog, LocalSynthesisInstallError>;
    readonly cancel: (modelId: string) => Effect.Effect<SpeechSynthesisCatalog>;
    /** Loads an installed model ahead of playback, so the first reply starts sooner. */
    readonly prepare: (modelId: string) => Effect.Effect<void>;
    /** Uses model files already on this machine, from a file or a folder to search. */
    readonly link: (
      source: string,
    ) => Effect.Effect<SpeechSynthesisCatalog, LocalSynthesisInstallError>;
    /** Removes the model, and the shared runtime once no installed model needs it. */
    readonly remove: (
      modelId: string,
    ) => Effect.Effect<SpeechSynthesisCatalog, LocalSynthesisInstallError>;
    /** MP3 and its PCM, delivered as each text chunk is synthesized. Stopping early cancels synthesis. */
    readonly stream: (
      request: SpeechSynthesisRequest,
    ) => Stream.Stream<SpeechSynthesisPart, SpeechSynthesisError>;
  }
>()("t3/speech/LocalSpeechSynthesis") {}

/** Picks the language a model declares for a setting such as `en-US`; `auto` picks none. */
export function localSynthesisLanguage(setting: string, languages: readonly string[]) {
  const wanted = setting.toLowerCase();
  const base = wanted.split("-")[0];
  return (
    languages.find((language) => language.toLowerCase() === wanted) ??
    languages.find((language) => language.toLowerCase() === base) ??
    languages.find((language) => language.toLowerCase().split("-")[0] === base)
  );
}

const atLeast = (version: string, minimum: string) => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [wantedMajor = 0, wantedMinor = 0] = minimum.split(".").map(Number);
  return major > wantedMajor || (major === wantedMajor && minor >= wantedMinor);
};

/** The audio.cpp build a host installs, or why it cannot run local speech models. */
export function localSynthesisRuntime(host: {
  readonly platform: string;
  readonly architecture: string;
  readonly libc: "gnu" | "musl" | undefined;
  readonly glibc: string | undefined;
}): { readonly runtime?: AudioCppRuntime; readonly error?: string } {
  // Independent of dictation's platform list: the speech builds cover hosts transcribe-cpp does not.
  const runtime =
    host.platform !== "linux" || host.libc === "gnu"
      ? audioCppRuntime(host.platform, host.architecture)
      : undefined;
  if (!runtime)
    return {
      error: `Local speech models are not available on ${host.platform}-${host.architecture}.`,
    };
  if (runtime.minimumGlibc && !(host.glibc && atLeast(host.glibc, runtime.minimumGlibc)))
    return {
      error: `Local speech models need glibc ${runtime.minimumGlibc} or newer. This environment has glibc ${host.glibc ?? "unknown"}.`,
    };
  return { runtime };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const config = yield* ServerConfig.ServerConfig;
  const scope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const { runtime, error: unavailable } = localSynthesisRuntime({
    platform,
    architecture,
    libc: platform === "linux" ? yield* HostProcess.LinuxLibc : undefined,
    glibc: platform === "linux" ? yield* HostProcess.GlibcVersion : undefined,
  });
  const runtimeFile = runtime && {
    id: "pingdotgg/audio.cpp",
    revision: AUDIO_CPP_VERSION,
    filename: runtime.filename,
    url: runtime.url,
    size: runtime.size,
    sha256: runtime.sha256,
  };
  const runtimeDirectory = path.join(
    config.stateDir,
    "speech",
    "runtime",
    `audio-cpp-${AUDIO_CPP_VERSION}-${platform}-${architecture}`,
  );
  const libraryPath = runtime && path.join(runtimeDirectory, runtime.library);
  // audio.cpp unpacks eSpeak's data package here on first use.
  const espeakCache = path.join(config.stateDir, "speech", "cache");
  // Written last, so a directory without it is an interrupted extraction.
  const completeMarker = path.join(runtimeDirectory, ".t3-complete");

  const runtimeReady = Effect.gen(function* () {
    if (!libraryPath) return false;
    return (yield* fs.exists(completeMarker)) && (yield* fs.exists(libraryPath));
  }).pipe(Effect.orElseSucceed(() => false));

  // System tar reads .tar.gz on macOS and Linux and .zip on Windows 10 and later.
  const extract = Effect.fn("LocalSpeechSynthesis.extract")(function* (
    library: string,
    archivePath: string,
  ) {
    const staging = `${runtimeDirectory}.${yield* random.uuidV4()}.part`;
    yield* fs.makeDirectory(staging, { recursive: true });
    yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("tar", ["-xf", archivePath, "-C", staging], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      const exitCode = yield* child.exitCode;
      if (exitCode !== 0 || !(yield* fs.exists(path.join(staging, library))))
        return yield* new LocalSynthesisInstallError({
          reason: "failed",
          cause: `tar exited with ${exitCode} or the archive has no library.`,
        });
      yield* fs.writeFileString(path.join(staging, ".t3-complete"), AUDIO_CPP_VERSION);
      yield* fs.remove(runtimeDirectory, { recursive: true, force: true });
      yield* fs.rename(staging, runtimeDirectory);
      // Runtimes from earlier releases for this platform; nothing loads them again.
      const parent = path.dirname(runtimeDirectory);
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const entry = path.join(parent, name);
        if (
          entry !== runtimeDirectory &&
          name.startsWith("audio-cpp-") &&
          name.endsWith(`-${platform}-${architecture}`)
        )
          yield* fs.remove(entry, { recursive: true, force: true }).pipe(Effect.ignore);
      }
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });

  type Transfer = {
    readonly modelId: string;
    /** Fixed once the install knows which files it needs, so finishing one does not shrink it. */
    size: number;
    runtime: number;
    model: number;
    verifying: boolean;
    fiber?: Fiber.Fiber<void, unknown>;
  };
  let transfer: Transfer | undefined;
  // A removal deletes the shared runtime and a link replaces model files, so neither may
  // overlap an install or each other.
  let changing = false;

  const catalog = Effect.gen(function* () {
    const ready = yield* runtimeReady;
    const runtimeSize = ready || !runtimeFile ? 0 : runtimeFile.size;
    const models = yield* Effect.forEach(LOCAL_SYNTHESIS_MODELS, (model) =>
      Effect.gen(function* () {
        const active = transfer?.modelId === model.id ? transfer : undefined;
        const files = modelFiles(model);
        const missing = yield* Effect.filter(files, (file) =>
          store.isReady(file).pipe(Effect.map((fileReady) => !fileReady)),
        );
        const installed = ready && missing.length === 0;
        const linkedFrom = installed ? yield* store.linkedFrom(model.file) : undefined;
        const install = active
          ? {
              state: active.verifying ? ("verifying" as const) : ("downloading" as const),
              size: active.size,
              downloaded: active.runtime + active.model,
            }
          : installed
            ? {
                state: "installed" as const,
                size: totalSize(files),
                ...(linkedFrom && { linkedFrom }),
              }
            : { state: "downloadable" as const, size: totalSize(missing) + runtimeSize };
        return {
          id: model.id,
          name: model.name,
          description: model.description,
          voices: model.voices.map((voice) => voice.id),
          ...(model.voices.some((voice) => voice.name) && {
            voiceNames: Object.fromEntries(
              model.voices.flatMap((voice) => (voice.name ? [[voice.id, voice.name]] : [])),
            ),
          }),
          languages: model.languages,
          ...(model.recommended && { recommended: true }),
          install,
          ...(model.appliesSpeed ? {} : { speedAppliedByProvider: false }),
        };
      }),
    );
    return {
      defaultModel: LOCAL_SYNTHESIS_MODELS[0]!.id,
      apiKeyProvider: null,
      supportsModelSelection: LOCAL_SYNTHESIS_MODELS.length > 1,
      supportsVoiceSelection: true,
      speedAppliedByProvider: true,
      models,
      ...(unavailable ? { error: unavailable } : {}),
    } satisfies SpeechSynthesisCatalog;
  });

  const installFailed = (cause: unknown) =>
    new LocalSynthesisInstallError({ reason: "failed", cause });
  const findModel = (modelId: string) =>
    Effect.fromNullishOr(LOCAL_SYNTHESIS_MODELS.find((model) => model.id === modelId)).pipe(
      Effect.mapError(() => new LocalSynthesisInstallError({ reason: "unknown-model" })),
    );

  // Publishes the transfer before forking: a cached file can finish before forkIn returns.
  const reserve = Effect.fn("LocalSpeechSynthesis.reserve")(function* (modelId: string) {
    const model = yield* findModel(modelId);
    if (!runtimeFile || !runtime)
      return yield* new LocalSynthesisInstallError({ reason: "unsupported-platform" });
    // Checked and claimed without yielding, so a concurrent download or removal cannot interleave.
    if (changing || (transfer && transfer.modelId !== modelId))
      return yield* new LocalSynthesisInstallError({ reason: "busy" });
    if (!transfer) {
      const state: Transfer = {
        modelId,
        size: totalSize(modelFiles(model)),
        runtime: 0,
        model: 0,
        verifying: false,
      };
      transfer = state;
      const install = Effect.gen(function* () {
        // Read after claiming: no removal or link can start while this transfer exists.
        const needsRuntime = !(yield* runtimeReady);
        const files = modelFiles(model);
        const missing = yield* Effect.filter(files, (file) =>
          store.isReady(file).pipe(Effect.map((fileReady) => !fileReady)),
        );
        state.size = (needsRuntime ? runtimeFile.size : 0) + totalSize(missing);
        if (needsRuntime) {
          const archivePath = yield* store.download(runtimeFile, {
            onProgress: (downloaded) => {
              state.runtime = downloaded;
              state.verifying = false;
            },
            onVerificationStart: () => {
              state.verifying = true;
            },
          });
          state.verifying = true;
          yield* extract(runtime.library, archivePath);
          yield* store.remove(runtimeFile).pipe(Effect.ignore);
          state.runtime = runtimeFile.size;
        }
        state.verifying = false;
        // Files already in place still go through `download`, which verifies them.
        let finished = 0;
        for (const file of files) {
          const counted = missing.includes(file);
          yield* store.download(file, {
            onProgress: (downloaded) => {
              if (counted) state.model = finished + downloaded;
              state.verifying = false;
            },
            onVerificationStart: () => {
              state.verifying = true;
            },
          });
          if (counted) finished += file.size;
        }
      });
      // Owned by the service, so a dropped request does not abandon a large download.
      state.fiber = yield* install.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (transfer === state) transfer = undefined;
          }),
        ),
        Effect.forkIn(scope),
      );
    }
    return transfer.fiber!;
  }, Effect.uninterruptible);

  const download = Effect.fn("LocalSpeechSynthesis.download")(function* (modelId: string) {
    const exit = yield* Fiber.await(yield* reserve(modelId));
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
      return yield* installFailed(Cause.squash(exit.cause));
    return yield* catalog;
  });

  const cancel = Effect.fn("LocalSpeechSynthesis.cancel")(function* (modelId: string) {
    const fiber = transfer?.modelId === modelId ? transfer.fiber : undefined;
    if (fiber) yield* Fiber.interrupt(fiber);
    return yield* catalog;
  });

  // One native request at a time; the worker process holds a single loaded model.
  const permit = yield* Semaphore.make(1);
  let worker: { readonly modelId: string; readonly model: LocalSynthesisModel } | undefined;
  // @effect-diagnostics-next-line abortControllerInEffect:off - The cached worker must also stop on service shutdown.
  const lifetime = new AbortController();
  const unloadWorker = Effect.promise(async () => {
    const current = worker;
    worker = undefined;
    await current?.model.dispose();
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => lifetime.abort()).pipe(Effect.andThen(unloadWorker)),
  );
  const idleDeadlines = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(idleDeadlines).pipe(
    Stream.switchMap(() =>
      Stream.fromEffect(
        Effect.sleep(IDLE_UNLOAD_MS).pipe(Effect.andThen(permit.withPermits(1)(unloadWorker))),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

  // Claimed without yielding, so a download, removal, or link cannot interleave.
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (transfer || changing) return new LocalSynthesisInstallError({ reason: "busy" });
        changing = true;
        return Effect.void;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          changing = false;
        }),
    );

  const link = Effect.fn("LocalSpeechSynthesis.link")(function* (source: string) {
    if (!runtimeFile)
      return yield* new LocalSynthesisInstallError({ reason: "unsupported-platform" });
    const linked = yield* exclusive(
      store
        .link(LOCAL_SYNTHESIS_MODELS.flatMap(modelFiles), source)
        .pipe(Effect.mapError(installFailed)),
    );
    // File ids name repositories, which several models share.
    const isLinked = (file: SpeechModelStore.ModelFile) =>
      linked.some((entry) => entry.filename === file.filename);
    const owners = LOCAL_SYNTHESIS_MODELS.filter((model) => modelFiles(model).some(isLinked));
    const model = owners.find((entry) => isLinked(entry.file)) ?? owners[0];
    if (!model) return yield* new LocalSynthesisInstallError({ reason: "not-found" });
    const missing = yield* Effect.filter(modelFiles(model), (file) =>
      store.isReady(file).pipe(Effect.map((fileReady) => !fileReady)),
    );
    if ((yield* runtimeReady) && missing.length === 0) return yield* catalog;
    // The model file is in place; an install fetches only the runtime and voices it lacks.
    return yield* download(model.id);
  });

  const remove = Effect.fn("LocalSpeechSynthesis.remove")(function* (modelId: string) {
    const model = yield* findModel(modelId);
    yield* exclusive(
      permit.withPermits(1)(
        Effect.gen(function* () {
          if (worker?.modelId === modelId) yield* unloadWorker;
          const remaining = yield* Effect.filter(LOCAL_SYNTHESIS_MODELS, (entry) =>
            entry.id === model.id ? Effect.succeed(false) : store.isReady(entry.file),
          );
          // eSpeak data and voice clips stay while another installed model reads them.
          const shared = new Set(remaining.flatMap(modelFiles).map((file) => file.filename));
          yield* Effect.forEach(
            modelFiles(model).filter((file) => !shared.has(file.filename)),
            (file) => store.remove(file),
          ).pipe(Effect.mapError(installFailed));
          if (model.espeakData && !remaining.some((entry) => entry.espeakData))
            yield* fs
              .remove(espeakCache, { recursive: true, force: true })
              .pipe(Effect.mapError(installFailed));
          if (remaining.length === 0)
            yield* fs
              .remove(runtimeDirectory, { recursive: true, force: true })
              .pipe(Effect.mapError(installFailed));
        }),
      ),
    );
    return yield* catalog;
  });

  const failure = (reason: SpeechSynthesisError["reason"], cause?: unknown) =>
    new SpeechSynthesisError({
      provider: "local",
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const findDefinition = (modelId: string) =>
    LOCAL_SYNTHESIS_MODELS.find((model) => model.id === (modelId || LOCAL_SYNTHESIS_MODELS[0]!.id));

  // The verified model and eSpeak files, or undefined while any is missing.
  const loadablePaths = Effect.fnUntraced(function* (definition: LocalModel) {
    if (!(yield* runtimeReady)) return undefined;
    const modelPath = yield* store.installedPath(definition.file);
    const espeakPath = definition.espeakData && (yield* store.installedPath(definition.espeakData));
    if (!modelPath || (definition.espeakData && !espeakPath)) return undefined;
    return { modelPath, espeakPath };
  });

  // Callers hold the permit, so one model loads at a time and synthesis waits for it.
  const ensureWorker = Effect.fnUntraced(function* (
    definition: LocalModel,
    paths: { readonly modelPath: string; readonly espeakPath: string | undefined },
  ) {
    if (!runtime || !libraryPath) return yield* failure("unavailable");
    if (worker?.model.alive && worker.modelId === definition.id) return worker.model;
    yield* unloadWorker;
    // Uninterruptible, so a stream stopped mid-load still records the process it started.
    const loaded = yield* Effect.tryPromise({
      try: () =>
        loadLocalSynthesisModel({
          libraryPath,
          backend: runtime.backend,
          modelPath: paths.modelPath,
          ...(paths.espeakPath && {
            env: { AUDIOCPP_ESPEAK_DATA: paths.espeakPath, AUDIOCPP_ESPEAK_CACHE: espeakCache },
          }),
          threads: Math.max(1, Math.min(8, NodeOS.availableParallelism() - 1)),
          signal: lifetime.signal,
        }),
      catch: (cause) => failure("unavailable", cause),
    }).pipe(
      Effect.tap((model) =>
        Effect.sync(() => {
          worker = { modelId: definition.id, model };
        }),
      ),
      Effect.uninterruptible,
    );
    yield* Effect.logInfo("Loaded the local speech model.", { backend: loaded.backend });
    return loaded;
  });

  const prepare = Effect.fn("LocalSpeechSynthesis.prepare")(function* (modelId: string) {
    const definition = findDefinition(modelId);
    if (!definition || (worker?.model.alive && worker.modelId === definition.id)) return;
    const paths = yield* loadablePaths(definition);
    if (!paths) return;
    yield* permit
      .withPermits(1)(ensureWorker(definition, paths))
      .pipe(
        Effect.andThen(Effect.sync(() => Queue.offerUnsafe(idleDeadlines, undefined))),
        Effect.catchTags({
          SpeechSynthesisError: (error) =>
            Effect.logWarning("Local speech model failed to load.", error),
        }),
      );
  });

  // Untraced: it runs inside the stream's own span.
  const speak = Effect.fnUntraced(function* (
    request: SpeechSynthesisRequest,
    queue: Queue.Queue<SpeechSynthesisPart, SpeechSynthesisError | Cause.Done>,
  ) {
    if (!runtime || !libraryPath) return yield* failure("unavailable");
    const definition = findDefinition(request.model);
    if (!definition) return yield* failure("model-unavailable");
    const paths = yield* loadablePaths(definition);
    const voice =
      definition.voices.find((entry) => entry.id === request.voice) ?? definition.voices[0]!;
    const voiceFile = voice.file ?? voice.clip?.file;
    const voicePath = voiceFile && (yield* store.installedPath(voiceFile));
    if (!paths || (voiceFile && !voicePath)) return yield* failure("missing-model");
    // Held until the stream ends, after any cancelled synthesis has stopped.
    // Interruptible, so a request abandoned while waiting stops waiting.
    yield* Effect.acquireRelease(
      Semaphore.take(permit, 1),
      () =>
        Semaphore.release(permit, 1).pipe(
          Effect.andThen(Effect.sync(() => Queue.offerUnsafe(idleDeadlines, undefined))),
        ),
      { interruptible: true },
    );
    const model = yield* ensureWorker(definition, paths);
    const language =
      definition.takesLanguage === false
        ? undefined
        : localSynthesisLanguage(request.language, model.languages);
    // One encoder spans the whole reply, so PCM time is MP3 time.
    let spokenSeconds = 0;
    const spoken = model
      .stream(
        {
          text: definition.speakable?.(request.text) ?? request.text,
          ...(language ? { language } : {}),
          options: {
            ...definition.options,
            ...(voice.clip
              ? definition.clipText && { [definition.clipText]: voice.clip.text }
              : voicePath
                ? { voice_embedding_file: voicePath }
                : definition.voiceOption !== false && { voice_id: voice.id }),
            ...(definition.appliesSpeed ? { speed: String(request.speed) } : {}),
          },
          ...(voice.clip && voicePath ? { voiceClip: voicePath } : {}),
        },
        (bytes) => Queue.offerUnsafe(queue, bytes),
        (pcm, rate) => {
          Queue.offerUnsafe(queue, { pcm, rate, startSeconds: spokenSeconds });
          spokenSeconds += pcm.length / rate;
        },
      )
      .then(
        () => Queue.endUnsafe(queue),
        (cause) => Queue.failCauseUnsafe(queue, Cause.fail(failure("unavailable", cause))),
      );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        model.cancel();
        return spoken;
      }),
    );
  });

  const stream = (request: SpeechSynthesisRequest) =>
    Stream.callback<SpeechSynthesisPart, SpeechSynthesisError>((queue) =>
      speak(request, queue),
    ).pipe(
      Stream.tapError((error) =>
        error.reason === "unavailable"
          ? Effect.logWarning("Local speech synthesis failed.", error)
          : Effect.void,
      ),
      Stream.withSpan("LocalSpeechSynthesis.stream"),
    );

  return LocalSpeechSynthesis.of({ catalog, download, cancel, link, remove, prepare, stream });
});

export const layer = Layer.effect(LocalSpeechSynthesis, make);
