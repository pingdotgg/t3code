import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const SAMPLE_RATE = 44_100;
const TARGET_PEAK = 0.42;
const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outputDirectory = NodePath.resolve(
  scriptDirectory,
  "../apps/mobile/assets/interaction-sounds",
);

const recipes = {
  bloom: {
    duration: 0.85,
    masterGain: 0.5,
    layers: [
      { frequency: 528, attack: 0.06, decay: 0.32, peak: 0.06 },
      { frequency: 528, detune: 12, attack: 0.06, decay: 0.34, peak: 0.05 },
    ],
    shimmer: { delay: 0.15, feedback: 0.2, wet: 0.12 },
  },
  success: {
    duration: 0.75,
    masterGain: 0.5,
    layers: [
      { frequency: 880, attack: 0.004, decay: 0.09, peak: 0.06 },
      { frequency: 1108.73, offset: 0.06, attack: 0.004, decay: 0.1, peak: 0.06 },
      { frequency: 1318.51, offset: 0.12, attack: 0.004, decay: 0.18, peak: 0.07 },
    ],
  },
};

function envelope(layer, elapsed) {
  if (elapsed < 0) return 0;
  if (elapsed < layer.attack) return elapsed / layer.attack;
  const decayElapsed = elapsed - layer.attack;
  if (decayElapsed >= layer.decay) return 0;
  return Math.exp((-7 * decayElapsed) / layer.decay);
}

function renderRecipe(recipe) {
  const sampleCount = Math.ceil(recipe.duration * SAMPLE_RATE);
  const dry = new Float64Array(sampleCount);

  for (const layer of recipe.layers) {
    const offset = layer.offset ?? 0;
    const frequency = layer.frequency * 2 ** ((layer.detune ?? 0) / 1200);
    for (let index = 0; index < sampleCount; index += 1) {
      const time = index / SAMPLE_RATE;
      const elapsed = time - offset;
      const amplitude = envelope(layer, elapsed);
      if (amplitude === 0) continue;
      dry[index] +=
        Math.sin(2 * Math.PI * frequency * elapsed) * amplitude * layer.peak * recipe.masterGain;
    }
  }

  const output = Float64Array.from(dry);
  if (recipe.shimmer) {
    const delaySamples = Math.round(recipe.shimmer.delay * SAMPLE_RATE);
    let repeat = 1;
    let repeatGain = recipe.shimmer.wet;
    while (repeatGain >= 0.001) {
      const offset = delaySamples * repeat;
      for (let index = 0; index + offset < sampleCount; index += 1) {
        output[index + offset] += dry[index] * repeatGain;
      }
      repeat += 1;
      repeatGain *= recipe.shimmer.feedback;
    }
  }

  let peak = 0;
  for (const sample of output) peak = Math.max(peak, Math.abs(sample));
  const scale = peak === 0 ? 1 : TARGET_PEAK / peak;
  return Int16Array.from(output, (sample) =>
    Math.round(Math.max(-1, Math.min(1, sample * scale)) * 0x7fff),
  );
}

function encodeWav(samples) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * bytesPerSample);
  }
  return buffer;
}

NodeFS.mkdirSync(outputDirectory, { recursive: true });
for (const [name, recipe] of Object.entries(recipes)) {
  NodeFS.writeFileSync(
    NodePath.resolve(outputDirectory, `${name}.wav`),
    encodeWav(renderRecipe(recipe)),
  );
}
