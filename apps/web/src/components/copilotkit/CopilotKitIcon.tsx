import { type SVGProps, useId } from "react";

export function CopilotKitIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  const gradientId = useId().replaceAll(":", "");

  return (
    <svg
      aria-hidden
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M8.162 7.758c2.093-2.738 3.831-5.445 4.498-7.63a.093.093 0 0 1 .14-.051c2.324 1.539 6.558 2.552 10.301 2.576a.09.09 0 0 1 .085.124c-1.243 3.158-2.765 8.817-2.823 15.28-.001.095-.135.13-.183.046-2.131-3.729-8.955-8.968-11.982-10.205a.09.09 0 0 1-.036-.14Z"
        fill={`url(#${gradientId}-purple)`}
      />
      <path
        d="M15.223 6.083A61.492 61.492 0 0 1 8.25 7.827c-.045.008-.055.071-.012.089 3.05 1.267 9.84 6.492 11.952 10.206a.017.017 0 0 0 .022.007.018.018 0 0 0 .01-.024l-4.999-12.02Z"
        fill={`url(#${gradientId}-blue)`}
      />
      <path
        d="M12.81.07c2.8 1.528 6.037 2.214 10.33 2.575.028.002.036.039.012.051-.55.282-3.695 1.883-6.03 2.74-.626.23-1.256.443-1.876.64a.028.028 0 0 1-.033-.016L12.746.128c-.017-.04.027-.078.065-.058Z"
        fill={`url(#${gradientId}-light-blue)`}
      />
      <path
        d="M12.725.075c.046-.019.1.003.119.05l7.514 17.923a.091.091 0 0 1-.148.1l-.02-.03L12.675.195a.091.091 0 0 1 .049-.12ZM23.06 2.66c.044-.025.1-.01.125.034.025.044.009.1-.035.124l-.008.005-.025.015-.1.054a41.384 41.384 0 0 1-1.811.92 47.05 47.05 0 0 1-4.876 2.008c-1.954.674-3.97 1.197-5.497 1.552a66.27 66.27 0 0 1-2.38.507l-.138.026-.036.007-.012.002a.091.091 0 1 1-.033-.18l.016.09-.015-.09h.002l.01-.002.035-.007.137-.025a66.16 66.16 0 0 0 2.373-.506c1.524-.354 3.533-.876 5.479-1.547a46.857 46.857 0 0 0 6.276-2.709c.166-.087.295-.156.381-.204l.099-.054.024-.014.008-.004Z"
        fill="#7867B8"
      />
      <path
        d="M13.838 2.272a.16.16 0 0 1 .107.2l-2.72 9.055h6.4l.061.013a.16.16 0 0 1 0 .295l-.061.013h-6.541L.679 24.099l-.05.04a.16.16 0 0 1-.194-.245l10.43-12.285 2.773-9.23a.16.16 0 0 1 .2-.107Z"
        fill="#ABABAB"
      />
      <path
        d="m7.809 21.461-1.232.173c.638 1.69 1.949 2.427 3.514 2.427 3.831 0 2.661-4.334 4.883-4.334 1.61 0 .956 3.513 4.423 3.513 2.116 0 2.326-2.131 1.966-3.048l-.008-.016-.567-.868c-.037-.058-.127-.036-.133.032l-.106 1.053a1.01 1.01 0 0 0 .003.219c.088.727.144 2.491-1.155 2.491-1.37 0-1.7-3.467-4.423-3.467-3.196 0-2.785 4.289-4.747 4.289-1.294 0-2.28-1.46-2.418-2.464Z"
        fill={`url(#${gradientId}-tail)`}
      />
      <defs>
        <linearGradient
          id={`${gradientId}-purple`}
          x1="17.852"
          x2="14.202"
          y1="1.467"
          y2="11.504"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#6430AB" />
          <stop offset="1" stopColor="#AA89D8" />
        </linearGradient>
        <linearGradient
          id={`${gradientId}-blue`}
          x1="15.024"
          x2="10.324"
          y1="7.125"
          y2="16.204"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#005DBB" />
          <stop offset="1" stopColor="#3D92E8" />
        </linearGradient>
        <linearGradient
          id={`${gradientId}-light-blue`}
          x1="17.122"
          x2="15.707"
          y1="1.467"
          y2="5.892"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1B70C4" />
          <stop offset="1" stopColor="#54A4F2" />
        </linearGradient>
        <linearGradient
          id={`${gradientId}-tail`}
          x1="6.577"
          x2="21.506"
          y1="21.758"
          y2="21.758"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4497EA" />
          <stop offset=".255" stopColor="#1463B2" />
          <stop offset=".499" stopColor="#0A437D" />
          <stop offset=".667" stopColor="#2476C8" />
          <stop offset=".973" stopColor="#0C549A" />
        </linearGradient>
      </defs>
    </svg>
  );
}
