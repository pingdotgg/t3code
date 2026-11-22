import { Icon, ProviderIcon } from "./Icon";
import "./Composer.css";

/** The prompt box: a 27pt-radius surface, plus, placeholder, provider chip and stop/send. */
export function Composer(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly working?: boolean;
}) {
  const hasText = props.value.trim().length > 0;
  return (
    <div className="m-composer-slot">
      <div className="m-composer m-continuous">
        <button className="m-composer-plus" aria-label="Attach">
          <Icon name="add" size={22} />
        </button>
        <input
          className="m-composer-input"
          value={props.value}
          placeholder={props.placeholder ?? "Ask anything"}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <span className="m-composer-provider">
          <ProviderIcon provider="claudeAgent" size={18} />
          <Icon name="chevron-down" size={12} style={{ opacity: 0.7 }} />
        </span>
        {hasText ? (
          <button className="m-composer-action m-composer-action-send" aria-label="Send">
            <Icon name="arrow-up" size={18} />
          </button>
        ) : props.working ? (
          <button className="m-composer-action m-composer-action-stop" aria-label="Stop">
            <span className="m-composer-stop" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
