import type { ReactNode } from "react";

import type { AppTextInputProps } from "./AppText";

/** A titled card holding a short form: its fields and the action that submits them. */
export interface FormSectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

export interface FormFieldProps extends Omit<AppTextInputProps, "className"> {
  /** Shown where the platform labels fields; the placeholder carries it elsewhere. */
  readonly label?: string;
  readonly accessibilityLabel: string;
}
