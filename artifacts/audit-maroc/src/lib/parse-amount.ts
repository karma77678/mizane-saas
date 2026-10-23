/**
 * Parses a monetary amount out of a spreadsheet cell.
 *
 * Accounting exports in Morocco and France mix conventions in the same file:
 * `1 234,56`, `1.234,56`, `1,234.56`, non-breaking or narrow spaces as
 * thousands separators, apostrophes, trailing `MAD`/`DH`, and negatives
 * written as `(1 234,56)`. Guessing wrong here silently corrupts every total
 * and every audit finding, so the rules are deliberately explicit and the
 * function reports `invalid` instead of quietly returning 0 — the import flow
 * flags those rows (rule ECR-07) rather than treating them as zero.
 *
 * Lives in its own module so it can be unit-tested without loading React.
 */
export function parseAmount(value: string): { value: number; invalid: boolean } {
  const text = value.trim();
  if (!text) return { value: 0, invalid: false };
  const parenthesized = /^\(.*\)$/.test(text);
  let normalized = text
    .replace(/[\s  ']/g, '')
    .replace(/[^\d,.\-+]/g, '');
  const negative = parenthesized || normalized.includes('-');
  normalized = normalized.replace(/[+-]/g, '');
  const commas = [...normalized.matchAll(/,/g)].map((match) => match.index ?? -1);
  const dots = [...normalized.matchAll(/\./g)].map((match) => match.index ?? -1);
  const lastComma = commas.at(-1) ?? -1;
  const lastDot = dots.at(-1) ?? -1;
  let decimalAt = -1;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both separators present: the rightmost one is the decimal mark.
    decimalAt = Math.max(lastComma, lastDot);
  } else {
    // One kind of separator: exactly three trailing digits means thousands
    // (`1.234`), anything else means decimals (`1.23`, `1.2345`).
    const separators = commas.length ? commas : dots;
    if (separators.length === 1) {
      const decimals = normalized.length - separators[0] - 1;
      if (decimals !== 3) decimalAt = separators[0];
    } else if (separators.length > 1) {
      const decimals = normalized.length - separators.at(-1)! - 1;
      if (decimals !== 3) decimalAt = separators.at(-1)!;
    }
  }
  const digits = decimalAt >= 0
    ? `${normalized.slice(0, decimalAt).replace(/[.,]/g, '')}.${normalized.slice(decimalAt + 1).replace(/[.,]/g, '')}`
    : normalized.replace(/[.,]/g, '');
  const parsed = Number(digits);
  if (!digits || !Number.isFinite(parsed)) return { value: 0, invalid: true };
  return { value: negative ? -parsed : parsed, invalid: false };
}
