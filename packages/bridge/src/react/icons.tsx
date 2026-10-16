const base = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true } as const;

export const IconFlip = () => (
  <svg {...base}>
    <path d="M5 2.5v11m0 0L2 10.5m3 3 3-3M11 13.5v-11m0 0-3 3m3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconChevron = () => (
  <svg {...base}>
    <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconBack = () => (
  <svg {...base}>
    <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconCheck = () => (
  <svg {...base}>
    <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconAlert = () => (
  <svg {...base}>
    <path d="M8 4.5v4m0 2.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const IconExternal = () => (
  <svg {...base} width={12} height={12}>
    <path d="M6 3H3.5v9.5H13V10M9 3h4v4m0-4L7.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Spinner = () => <span className="iub-spinner" aria-hidden />;
