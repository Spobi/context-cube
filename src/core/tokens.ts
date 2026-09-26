/** Token estimates are characters ÷ charsPerToken, rounded up. Always labeled as estimates. */
export function estimateTokens(chars: number, charsPerToken = 4): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / charsPerToken);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "~18,000" style, rounded to 2 significant-ish digits for large numbers. */
export function fmtApprox(n: number): string {
  if (n < 1000) return `~${fmtInt(n)}`;
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return `~${fmtInt(Math.round(n / magnitude) * magnitude)}`;
}
