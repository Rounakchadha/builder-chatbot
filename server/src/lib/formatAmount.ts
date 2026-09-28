/** Mirrors the widget's display formatting so server-generated text (lender Q&A answers) reads
 * the same way as the result card: switches to crore above 100 lakh. */
export function formatAmount(amountLakh: number): string {
  const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (amountLakh >= 100) return `₹${trim(amountLakh / 100)} crore`;
  return `₹${trim(amountLakh)} lakh`;
}
