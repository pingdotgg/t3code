/** ServerSecretStore entry holding the environment-owned OpenAI API key. Lives
    in its own module so the environment descriptor can check for the key
    without importing the broker (and, through it, the auth layer). */
export const OPENAI_API_KEY_SECRET_NAME = "openai-api-key";
