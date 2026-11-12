import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const IconHome = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />
  </svg>
);

export const IconEnvelope = (p: P) => (
  <svg {...base} {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2.5" />
    <path d="M5 7.5c2.2 2 4.5 3 7 3s4.8-1 7-3" />
    <circle cx="12" cy="10.5" r="2" />
  </svg>
);

export const IconWallet = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <rect x="4" y="8" width="16" height="12" rx="2.5" />
    <path d="M15.5 14h1.5" />
  </svg>
);

export const IconLedger = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 4h11a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2z" />
    <path d="M6 18a2 2 0 0 1 2-2h11M10 8h5M10 11.5h5" />
  </svg>
);

export const IconCopy = (p: P) => (
  <svg {...base} {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base} strokeWidth={2.4} {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const IconExternal = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14 5h5v5M19 5l-8 8M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H10" />
  </svg>
);

export const IconShare = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 15V4M8 8l4-4 4 4" />
    <path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12" />
  </svg>
);

export const IconGlobe = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z" />
  </svg>
);

export const IconPlus = (p: P) => (
  <svg {...base} strokeWidth={2.2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconMinus = (p: P) => (
  <svg {...base} strokeWidth={2.2} {...p}>
    <path d="M5 12h14" />
  </svg>
);

export const IconInfo = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

export const IconAlert = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 4 2.8 19.5h18.4z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);

export const IconCoin = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M14.5 9.2c-.5-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.4-2.5-1.2M12 6.5V8M12 16v1.5" />
  </svg>
);

export const IconVault = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <circle cx="11" cy="12" r="3" />
    <path d="M11 9v.01M17 10v4M6.5 19v1.5M17.5 19v1.5" />
  </svg>
);

export const IconSpark = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9z" />
    <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  </svg>
);

export const IconSwap = (p: P) => (
  <svg {...base} {...p}>
    <path d="M7 4 4 7l3 3M4 7h12M17 20l3-3-3-3M20 17H8" />
  </svg>
);

export const IconGauge = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4.5 17a8 8 0 1 1 15 0" />
    <path d="m12 13 3.5-4M12 13h.01" />
  </svg>
);

export const IconShield = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3.5 19 6v5.5c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </svg>
);

export const IconKey = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
  </svg>
);

export const IconPhone = (p: P) => (
  <svg {...base} {...p}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10.5 18.5h3" />
  </svg>
);

export const IconArrowRight = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const IconRefresh = (p: P) => (
  <svg {...base} {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4" />
  </svg>
);

export const IconReturn = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 7 5 11l4 4" />
    <path d="M5 11h9.5a4.5 4.5 0 0 1 0 9H12" />
  </svg>
);

export const IconQr = (p: P) => (
  <svg {...base} {...p}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2M20 14v.01M18 18h2v2M14 20h2" />
  </svg>
);

/** The brand mark: a red envelope with a gold seal. */
export const BrandMark = (p: P) => (
  <svg viewBox="0 0 32 32" aria-hidden {...p}>
    <defs>
      <linearGradient id="bm-r" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#cf2b31" />
        <stop offset="1" stopColor="#8f141a" />
      </linearGradient>
      <radialGradient id="bm-g" cx="0.38" cy="0.32" r="0.7">
        <stop offset="0" stopColor="#fbe3a6" />
        <stop offset="0.6" stopColor="#d3a548" />
        <stop offset="1" stopColor="#9c7124" />
      </radialGradient>
    </defs>
    <rect x="6" y="2" width="20" height="28" rx="4" fill="url(#bm-r)" />
    <path d="M6 6.5Q16 16 26 6.5V6a4 4 0 0 0-4-4H10a4 4 0 0 0-4 4z" fill="#d9363c" />
    <path d="M6.3 7.2Q16 16.4 25.7 7.2" fill="none" stroke="#efc877" strokeWidth="0.9" opacity="0.8" />
    <circle cx="16" cy="12.6" r="3.6" fill="url(#bm-g)" />
  </svg>
);
