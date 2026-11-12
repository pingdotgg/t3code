// Self-contained because the native worker embeds this factory in Node, Electron and SEA.
export function createSpeechAudio(config: {
  frameSamples: number;
  filterSilence: boolean;
  nativeStreaming: boolean;
  longForm: boolean;
  maxAudioMs: number;
}) {
  const rate = 16_000;
  const frame = config.frameSamples;
  const prefill = Math.ceil((450 * rate) / 1000 / frame);
  const onset = Math.ceil((60 * rate) / 1000 / frame);
  const tail = Math.ceil(((config.nativeStreaming ? 1650 : 450) * rate) / 1000 / frame);
  const eligible = !config.nativeStreaming && !config.longForm;
  // Preserve the existing output-limit headroom and bounded offline retries.
  const maximum = Math.min(
    40 * rate,
    config.maxAudioMs > 0 ? Math.max(1, Math.floor((config.maxAudioMs * rate) / 2000)) : 40 * rate,
  );
  const minimum = Math.min(5 * rate, Math.floor(maximum / 4));
  const target = Math.min(30 * rate, maximum * 0.75);
  const blocks: { start: number; pcm: Float32Array }[] = [];
  const probs: number[] = [];
  const keep: boolean[] = [];
  let length = 0;
  let start = 0;
  let streamAt = 0;
  let inSpeech = false;
  let onsetCount = 0;
  let hangover = 0;

  const raw = (from: number, to: number) => {
    const output = new Float32Array(to - from);
    for (const block of blocks) {
      const left = Math.max(from, block.start);
      const right = Math.min(to, block.start + block.pcm.length);
      if (left < right)
        output.set(block.pcm.subarray(left - block.start, right - block.start), left - from);
    }
    return output;
  };
  const read = (from: number, to: number) => {
    const pcm = raw(from, to);
    if (!config.filterSilence) return pcm;
    let count = 0;
    for (let at = from; at < to;) {
      const end = Math.min(to, (Math.floor(at / frame) + 1) * frame);
      if (keep[Math.floor(at / frame)]) {
        pcm.copyWithin(count, at - from, end - from);
        count += end - at;
      }
      at = end;
    }
    return pcm.subarray(0, count);
  };
  // Silero timestamp hysteresis is separate from the capture filter's 0.3 threshold.
  const pauses = (samples: number, final: boolean) => {
    const segments: { start: number; end: number }[] = [];
    let speechStart: number | undefined;
    let silenceStart: number | undefined;
    for (let i = 0; i < probs.length; i++) {
      const at = i * frame;
      if (probs[i]! >= 0.5) {
        silenceStart = undefined;
        speechStart ??= at;
      } else if (probs[i]! < 0.35 && speechStart !== undefined) {
        silenceStart ??= at;
        if (at - silenceStart >= 0.1 * rate) {
          if (silenceStart - speechStart > 0.25 * rate)
            segments.push({ start: speechStart, end: silenceStart });
          speechStart = silenceStart = undefined;
        }
      }
    }
    if (speechStart !== undefined && samples - speechStart > 0.25 * rate)
      segments.push({ start: speechStart, end: samples });
    const candidates: { cut: number; gap: number }[] = [];
    let end = 0;
    for (const segment of segments) {
      if (segment.start > end)
        candidates.push({
          cut: Math.floor((end + segment.start) / 2),
          gap: (segment.start - end) / rate,
        });
      end = segment.end;
    }
    // An open pause's midpoint can still move, so only final audio uses it.
    if (final && samples > end)
      candidates.push({ cut: Math.floor((end + samples) / 2), gap: (samples - end) / rate });
    return candidates;
  };

  return {
    append(pcm: Float32Array) {
      blocks.push({ start: length, pcm });
      length += pcm.length;
    },
    score(firstFrame: number, scores: readonly number[]) {
      if (firstFrame !== probs.length || scores.some((p) => !Number.isFinite(p) || p < 0 || p > 1))
        throw new Error("Invalid Silero frame sequence.");
      for (const probability of scores) {
        const i = probs.length;
        probs.push(probability);
        keep.push(false);
        const voiced = probability > 0.3;
        if (!inSpeech && voiced) {
          if (++onsetCount >= onset) {
            inSpeech = true;
            hangover = tail;
            onsetCount = 0;
            for (let j = Math.max(0, i - prefill); j <= i; j++) keep[j] = true;
          }
        } else if (inSpeech && voiced) {
          hangover = tail;
          keep[i] = true;
        } else if (inSpeech && hangover > 0) {
          hangover--;
          keep[i] = true;
        } else {
          inSpeech = false;
          onsetCount = 0;
        }
      }
    },
    audio: () => raw(0, length),
    samples: () => length,
    take(final = false): Float32Array[] {
      const samples = Math.min(length, probs.length * frame);
      // Preserve a very short utterance or syllable stopped before onset confirms.
      if (final && onsetCount > 0)
        for (let i = Math.max(0, probs.length - 1 - prefill); i < probs.length; i++) keep[i] = true;
      if (config.nativeStreaming) {
        const output = read(streamAt, samples);
        let lastKept = streamAt;
        for (let i = Math.floor(streamAt / frame); i < probs.length; i++)
          if (!config.filterSilence || keep[i]) lastKept = Math.min(samples, (i + 1) * frame);
        streamAt = Math.max(lastKept, Math.max(0, samples - prefill * frame));
        return output.length ? [output] : [];
      }
      const chunks: Float32Array[] = [];
      const lookahead = Math.max(minimum, (prefill + onset) * frame);
      if (eligible && samples - start > maximum + (final ? 0 : lookahead)) {
        const candidates = pauses(samples, final);
        while (samples - start > maximum + (final ? 0 : lookahead)) {
          let best: { cut: number; score: number } | undefined;
          let fallback: typeof best;
          for (const candidate of candidates) {
            const position = candidate.cut - start;
            if (position < minimum || position > maximum) continue;
            const offTarget = (position - target) / rate;
            const score =
              Math.min(candidate.gap, 1) - Math.abs(offTarget) * (offTarget > 0 ? 0.1 : 0.05);
            if (!fallback || score > fallback.score) fallback = { cut: candidate.cut, score };
            if (samples - candidate.cut >= minimum && (!best || score > best.score))
              best = { cut: candidate.cut, score };
          }
          const hard =
            start +
            (samples - start < maximum + minimum ? Math.floor((samples - start) / 2) : maximum);
          const cut = (best ?? fallback)?.cut ?? hard;
          const chunk = read(start, cut);
          if (chunk.length) chunks.push(chunk);
          start = cut;
        }
      }
      if (final && samples > start) {
        const chunk = read(start, samples);
        if (chunk.length) chunks.push(chunk);
        start = samples;
      }
      return chunks;
    },
  };
}
