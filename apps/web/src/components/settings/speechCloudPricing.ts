import type { SpeechCloudModelPricing } from "@t3tools/contracts";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fractionOfCent = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2,
});
const usd = {
  format: (value: number) =>
    (value >= 1 ? dollars : value >= 0.01 ? cents : fractionOfCent).format(value),
};

/** One comparable price per OpenRouter transcription model: per hour of audio, or per token. */
export function formatSpeechCloudPrice(pricing: SpeechCloudModelPricing): string | null {
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0) return null;
  if (completion > 0)
    return `${usd.format(prompt * 1e6)}/M in, ${usd.format(completion * 1e6)}/M out`;
  if (prompt === 0) return "Free";
  // OpenRouter's API omits the unit: audio models list a per-hour rate when it is
  // this large (MAI-Transcribe's 0.1) and a per-second rate otherwise (Whisper's 0.0001).
  return `${usd.format(prompt >= 0.01 ? prompt : prompt * 3600)}/hr`;
}
