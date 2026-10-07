import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The employer master list (~182k names, deduped from the PFL/TCL/Indus employer-master export —
 * see server/src/data/employers.json) — used for Personal loan's "who's your employer" typeahead
 * (flows/personalLoan.ts's plEmployer step). Loaded once into memory at startup; a plain substring
 * scan over ~182k short strings is fast enough per debounced keystroke without needing a real
 * search index.
 */
const EMPLOYERS: string[] = JSON.parse(readFileSync(join(__dirname, '../data/employers.json'), 'utf-8'));

// Case-insensitive exact-match lookup for validating a submitted answer (see plEmployer's validate).
const EMPLOYERS_LOWER = new Set(EMPLOYERS.map((n) => n.toLowerCase()));

export function isKnownEmployer(name: string): boolean {
  return EMPLOYERS_LOWER.has(name.trim().toLowerCase());
}

/** Prefix matches first (closer to what the customer is typing), then contains-matches, capped at
 * `limit`. Returns [] for a query shorter than 2 characters — too broad to be useful. */
export function searchEmployers(query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const prefixMatches: string[] = [];
  const containsMatches: string[] = [];
  for (const name of EMPLOYERS) {
    const lower = name.toLowerCase();
    if (lower.startsWith(q)) {
      prefixMatches.push(name);
      if (prefixMatches.length >= limit) break;
    } else if (containsMatches.length < limit && lower.includes(q)) {
      containsMatches.push(name);
    }
  }
  return [...prefixMatches, ...containsMatches].slice(0, limit);
}
