import type { SectionCredentialType } from "../lib/sectionCredentials";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

interface SectionCredentialsFieldsProps {
  readonly type: SectionCredentialType;
  readonly username: string;
  readonly password: string;
  readonly secretKey: string;
  readonly onTypeChange: (type: SectionCredentialType) => void;
  readonly onUsernameChange: (value: string) => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onSecretKeyChange: (value: string) => void;
}

const CREDENTIAL_TYPE_LABELS: Record<SectionCredentialType, string> = {
  none: "None",
  "username-password": "Username and password",
  "secret-key": "Secret key",
};

export function SectionCredentialsFields(props: SectionCredentialsFieldsProps) {
  return (
    <div className="grid gap-3 rounded-md border border-border/70 p-3">
      <div className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Credential</span>
        <Select
          value={props.type}
          onValueChange={(value) => {
            if (value === "none" || value === "username-password" || value === "secret-key") {
              props.onTypeChange(value);
            }
          }}
        >
          <SelectTrigger className="w-full" aria-label="Credential type">
            <SelectValue>{CREDENTIAL_TYPE_LABELS[props.type]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="none">
              None
            </SelectItem>
            <SelectItem hideIndicator value="username-password">
              Username and password
            </SelectItem>
            <SelectItem hideIndicator value="secret-key">
              Secret key
            </SelectItem>
          </SelectPopup>
        </Select>
      </div>

      {props.type === "username-password" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Username</span>
            <Input
              aria-label="Credential username"
              value={props.username}
              onChange={(event) => props.onUsernameChange(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Password</span>
            <Input
              aria-label="Credential password"
              type="password"
              value={props.password}
              onChange={(event) => props.onPasswordChange(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {props.type === "secret-key" ? (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Secret key</span>
          <Textarea
            aria-label="Credential secret key"
            className="min-h-24 font-mono text-xs"
            value={props.secretKey}
            onChange={(event) => props.onSecretKeyChange(event.target.value)}
          />
        </div>
      ) : null}

      {props.type !== "none" ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This value is stored in plain text and included in the section context sent to the AI.
        </p>
      ) : null}
    </div>
  );
}
