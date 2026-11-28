/** The Ry3 Code cat without its tile: it takes the surrounding text color, and its eyes are the sidebar's own color. */
export function Ry3Mark(props: { readonly className?: string; readonly eyeColor?: string }) {
  return (
    <svg viewBox="77 61 358 390" aria-hidden="true" className={props.className} fill="currentColor">
      <g transform="translate(267 267) scale(1.07) translate(-252 -262)">
        <g transform="rotate(-11 256 312)">
          <path
            d="M132 304 C98 204 108 126 152 86 C180 132 208 168 246 216 Z"
            stroke="currentColor"
            strokeWidth={20}
            strokeLinejoin="round"
          />
          <path
            d="M380 302 C412 214 404 144 366 100 C336 140 308 174 266 218 Z"
            stroke="currentColor"
            strokeWidth={20}
            strokeLinejoin="round"
          />
          <ellipse cx={256} cy={312} rx={152} ry={118} />
          <ellipse cx={208} cy={310} rx={23} ry={34} fill={props.eyeColor ?? "var(--sidebar)"} />
          <ellipse cx={308} cy={304} rx={23} ry={34} fill={props.eyeColor ?? "var(--sidebar)"} />
        </g>
      </g>
    </svg>
  );
}
