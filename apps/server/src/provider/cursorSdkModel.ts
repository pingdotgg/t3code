const CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION: Readonly<Record<string, string>> = {
  context: "contextWindow",
  fast: "fastMode",
};

const PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER: Readonly<Record<string, string>> = {
  contextWindow: "context",
  fastMode: "fast",
};

export function cursorSdkProviderOptionId(parameterId: string): string {
  return CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION[parameterId] ?? parameterId;
}

export function cursorSdkParameterId(providerOptionId: string): string {
  return PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER[providerOptionId] ?? providerOptionId;
}

export function cursorSdkParameterPriority(parameterId: string): number {
  switch (parameterId) {
    case "effort":
    case "reasoning":
      return 0;
    case "context":
      return 1;
    case "fast":
      return 2;
    case "thinking":
      return 3;
    default:
      return 4;
  }
}
