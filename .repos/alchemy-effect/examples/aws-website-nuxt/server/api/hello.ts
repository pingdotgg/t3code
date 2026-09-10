// An ordinary nitro API route. On AWS the nitro server runs in a plain
// Node Lambda, so environment values from alchemy.run.ts are read from
// `process.env`.
export default defineEventHandler(() => {
  return {
    greeting:
      typeof process.env.GREETING === "string" ? process.env.GREETING : null,
  };
});
