import { CHAIN_COLORS, CHAIN_LOGOS } from "./logos.js";

export function ChainLogo({ chain, name, size = 24 }: { chain: string | null; name: string; size?: number }) {
  const svg = chain ? CHAIN_LOGOS[chain] : undefined;
  const style = { width: size, height: size };
  if (svg) {
    return (
      <img
        className="iub-logo"
        style={{ ...style, padding: Math.round(size * 0.16) }}
        alt=""
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      />
    );
  }
  return (
    <span
      className="iub-logo iub-logo-badge"
      style={{ ...style, background: (chain && CHAIN_COLORS[chain]) || "var(--iub-raised)", fontSize: size * 0.46 }}
      aria-hidden
    >
      {name.charAt(0)}
    </span>
  );
}

export function UsdcLogo({ size = 20 }: { size?: number }) {
  return (
    <svg className="iub-logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <path
        fill="#fff"
        d="M20.4 18.3c0-2.3-1.4-3.1-4.2-3.4-2-.3-2.4-.8-2.4-1.7s.7-1.5 2-1.5c1.2 0 1.8.4 2.2 1.4.1.2.2.3.4.3h1c.3 0 .4-.2.4-.4-.3-1.4-1.4-2.5-2.9-2.7V8.9c0-.3-.2-.4-.5-.5h-.9c-.3 0-.4.2-.5.5v1.4c-1.9.3-3.1 1.5-3.1 3.1 0 2.2 1.3 3 4.1 3.4 1.9.3 2.5.7 2.5 1.8s-.9 1.8-2.2 1.8c-1.7 0-2.3-.7-2.5-1.7 0-.3-.2-.4-.4-.4h-1.1c-.3 0-.4.2-.4.4.3 1.6 1.3 2.7 3.3 3v1.4c0 .3.2.4.5.5h.9c.3 0 .4-.2.5-.5v-1.4c1.9-.3 3.2-1.6 3.2-3.3z"
      />
      <path
        fill="#fff"
        d="M12.9 24.9c-4.9-1.8-7.4-7.2-5.6-12.1.9-2.6 3-4.6 5.6-5.6.3-.1.4-.3.4-.6v-.9c0-.3-.1-.4-.4-.5h-.2c-5.9 1.9-9.1 8.2-7.2 14.1 1.1 3.5 3.8 6.1 7.2 7.2.3.1.5 0 .6-.2v-1.1c0-.1-.2-.3-.4-.4zm6.3-19.6c-.3-.1-.5 0-.6.2v1.1c0 .3.1.4.4.6 4.9 1.8 7.4 7.2 5.6 12.1-.9 2.6-3 4.6-5.6 5.6-.3.1-.4.3-.4.6v.9c0 .3.1.4.4.5h.2c5.9-1.9 9.1-8.2 7.2-14.1-1.1-3.5-3.8-6.2-7.2-7.3z"
      />
    </svg>
  );
}
