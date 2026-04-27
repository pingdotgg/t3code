type FormaMarkProps = {
  className?: string;
  title?: string;
};

const pathClassName =
  "[stroke-dasharray:1] [stroke-dashoffset:1] [animation:forma-mark-draw_1.05s_ease_forwards]";

export function FormaMark({ className, title = "Forma" }: FormaMarkProps) {
  return (
    <svg
      aria-label={title}
      className={className}
      fill="none"
      role="img"
      viewBox="0 0 432 489"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <path
        className={`${pathClassName} [animation-delay:0ms]`}
        d="M212.06 3.50488C214.381 2.16517 217.24 2.16525 219.56 3.50488L425.372 122.329C427.692 123.669 429.122 126.145 429.122 128.824L429.121 366.475C429.121 369.154 427.691 371.63 425.371 372.97L239.56 480.247C234.948 482.91 230 484.737 224.927 485.728C221.415 486.414 218.023 483.461 218.023 479.165V253.589C218.023 249.123 215.641 244.997 211.773 242.764L16.4187 129.976C12.6981 127.827 11.8369 123.414 14.1873 120.715C17.5818 116.817 21.6372 113.445 26.2498 110.782L212.06 3.50488Z"
        pathLength={1}
        stroke="currentColor"
        strokeWidth="5"
      />
      <path
        className={`${pathClassName} [animation-delay:220ms]`}
        d="M2.50061 172.121C2.50078 166.347 8.75073 162.739 13.7506 165.625L182.065 262.802C184.385 264.142 185.815 266.618 185.815 269.297V463.649C185.815 469.422 179.565 473.032 174.565 470.145V470.144L121.427 439.465C119.107 438.126 117.676 435.65 117.676 432.97V312.055C117.676 307.589 115.294 303.463 111.426 301.23L6.25061 240.505C3.93016 239.166 2.50059 236.69 2.50061 234.01V172.121Z"
        pathLength={1}
        stroke="currentColor"
        strokeWidth="5"
      />
      <path
        className={`${pathClassName} [animation-delay:440ms]`}
        d="M2.50098 288.522C2.50118 282.749 8.75107 279.141 13.751 282.027L81.7178 321.27C84.038 322.609 85.4678 325.085 85.4678 327.765L85.4668 405.715C85.4668 411.488 79.2168 415.097 74.2168 412.21L6.25 372.97C3.92956 371.63 2.5001 369.154 2.5 366.475L2.50098 288.522Z"
        pathLength={1}
        stroke="currentColor"
        strokeWidth="5"
      />
    </svg>
  );
}
