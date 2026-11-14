/** The lead of a decision sheet: what is being asked, above the choices. */
export interface SheetIntroProps {
  /** A short kicker such as "Confirm", where the platform uses one. */
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}
