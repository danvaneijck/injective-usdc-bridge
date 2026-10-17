const base = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true } as const;
const stroke = { stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const IconFlip = () => (
  <svg {...base}>
    <path d="M5 2.5v11m0 0L2 10.5m3 3 3-3M11 13.5v-11m0 0-3 3m3-3 3 3" {...stroke} />
  </svg>
);

export const IconChevron = () => (
  <svg {...base}>
    <path d="m4 6 4 4 4-4" {...stroke} />
  </svg>
);

export const IconChevronRight = () => (
  <svg {...base}>
    <path d="m6 4 4 4-4 4" {...stroke} />
  </svg>
);

export const IconBack = () => (
  <svg {...base}>
    <path d="M10 3 5 8l5 5" {...stroke} />
  </svg>
);

export const IconArrow = () => (
  <svg {...base} width={12} height={12}>
    <path d="M3 8h10m0 0L9 4m4 4-4 4" {...stroke} />
  </svg>
);

export const IconCheck = () => (
  <svg {...base}>
    <path d="m3.5 8.5 3 3 6-7" {...stroke} strokeWidth={2} />
  </svg>
);

export const IconAlert = () => (
  <svg {...base}>
    <path d="M8 4.5v4m0 2.5v.01" {...stroke} strokeWidth={2} />
  </svg>
);

export const IconInfo = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="6.25" {...stroke} />
    <path d="M8 7.5v3.5M8 5v.01" {...stroke} />
  </svg>
);

export const IconExternal = () => (
  <svg {...base} width={12} height={12}>
    <path d="M6 3H3.5v9.5H13V10M9 3h4v4m0-4L7.5 8.5" {...stroke} />
  </svg>
);

export const IconClose = () => (
  <svg {...base}>
    <path d="m4 4 8 8m0-8-8 8" {...stroke} />
  </svg>
);

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="7" cy="7" r="4.25" {...stroke} />
    <path d="m10.5 10.5 3 3" {...stroke} />
  </svg>
);

export const IconBolt = () => (
  <svg {...base}>
    <path d="M9 1.75 3.5 9H8l-1 5.25L12.5 7H8z" {...stroke} />
  </svg>
);

/** A parcel: delivered for you. */
export const IconParcel = () => (
  <svg {...base}>
    <path d="M2.75 5 8 2.25 13.25 5v6L8 13.75 2.75 11z" {...stroke} />
    <path d="M2.75 5 8 7.75 13.25 5M8 7.75v6" {...stroke} />
  </svg>
);

export const IconBell = () => (
  <svg {...base}>
    <path d="M4.25 6.5a3.75 3.75 0 0 1 7.5 0c0 3.5 1.5 4.75 1.5 4.75H2.75s1.5-1.25 1.5-4.75M6.75 13.5a1.4 1.4 0 0 0 2.5 0" {...stroke} />
  </svg>
);

export const IconClock = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="6.25" {...stroke} />
    <path d="M8 4.75V8l2.25 1.5" {...stroke} />
  </svg>
);

export const IconCopy = () => (
  <svg {...base} width={14} height={14}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="2" {...stroke} />
    <path d="M10.75 5.25V4.5a1.75 1.75 0 0 0-1.75-1.75H4.5A1.75 1.75 0 0 0 2.75 4.5V9a1.75 1.75 0 0 0 1.75 1.75h.75" {...stroke} />
  </svg>
);

export const IconWallet = () => (
  <svg {...base}>
    <path d="M12.5 5.25V4a1.25 1.25 0 0 0-1.25-1.25H4A1.75 1.75 0 0 0 2.25 4.5v7A1.75 1.75 0 0 0 4 13.25h8.5a1.25 1.25 0 0 0 1.25-1.25V6.5a1.25 1.25 0 0 0-1.25-1.25H4" {...stroke} />
    <circle cx="11" cy="9.25" r=".75" fill="currentColor" />
  </svg>
);

export const IconInbox = () => (
  <svg viewBox="0 0 48 48" width={48} height={48} fill="none" aria-hidden>
    <rect x="6" y="10" width="36" height="28" rx="8" stroke="currentColor" strokeWidth="2" />
    <path d="M6 26h9l3 5h12l3-5h9" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </svg>
);

/** A check that draws itself, for the moment a transfer lands. */
export const IconSuccess = () => (
  <svg viewBox="0 0 52 52" width={52} height={52} fill="none" aria-hidden className="iub-success">
    <circle className="iub-success-ring" cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="2.5" />
    <path className="iub-success-check" d="m15.5 27 7 7 14-15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Spinner = () => <span className="iub-spinner" aria-hidden />;

/** A softly pulsing dot for anything still moving. */
export const PulseDot = () => <span className="iub-pulse" aria-hidden />;
