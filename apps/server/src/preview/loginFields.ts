/** What a login fill reads about one `<input>`, in document order. Never its value. */
export interface LoginFieldCandidate {
  readonly type: string;
  readonly autocomplete: string;
  readonly inputMode: string;
  readonly maxLength: number;
  readonly usable: boolean;
}

export interface LoginFields {
  readonly username?: number;
  readonly password?: number;
  readonly otp?: number;
}

const TEXT_TYPES = new Set(["text", "email", "tel", ""]);

const tokens = (candidate: LoginFieldCandidate) =>
  candidate.autocomplete.toLowerCase().split(/\s+/);

const isShortNumeric = (candidate: LoginFieldCandidate) =>
  (candidate.type === "number" ||
    candidate.type === "tel" ||
    candidate.inputMode === "numeric" ||
    tokens(candidate).includes("one-time-code")) &&
  candidate.maxLength >= 4 &&
  candidate.maxLength <= 8;

/** Indexes of the page's username, password, and one-time code fields; absent when not found. */
export const detectLoginFields = (candidates: ReadonlyArray<LoginFieldCandidate>): LoginFields => {
  const usable = candidates.flatMap((candidate, index) =>
    candidate.usable ? [{ candidate, index }] : [],
  );
  const passwords = usable.filter(({ candidate }) => candidate.type === "password");
  const password =
    passwords.find(({ candidate }) => tokens(candidate).includes("current-password")) ??
    passwords.find(({ candidate }) => !tokens(candidate).includes("new-password"));
  const texts = usable.filter(({ candidate }) => TEXT_TYPES.has(candidate.type));
  const username =
    texts.find(({ candidate }) =>
      tokens(candidate).some((token) => token === "username" || token === "email"),
    ) ??
    (password === undefined ? undefined : texts.findLast(({ index }) => index < password.index));
  const otpCandidates = usable.filter(
    ({ candidate, index }) =>
      candidate.type !== "password" && index !== username?.index && isShortNumeric(candidate),
  );
  const otp =
    usable.find(({ candidate }) => tokens(candidate).includes("one-time-code")) ??
    (otpCandidates.length === 1 ? otpCandidates[0] : undefined);
  return {
    ...(username === undefined || username.index === otp?.index
      ? {}
      : { username: username.index }),
    ...(password === undefined ? {} : { password: password.index }),
    ...(otp === undefined ? {} : { otp: otp.index }),
  };
};
