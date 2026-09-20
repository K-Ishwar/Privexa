import type { Label } from './schema';

/** Hints are consumed locally; callers must never place them in a Scene. */
export type DomHints = {
  kind?: 'input' | 'button' | 'link' | 'text' | 'image' | 'select' | 'checkbox';
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  text?: string;
};

const privateLabel = (v: string): Label | undefined => {
  if (/aadhaar|aadhar|uidai|unique\s*identification/i.test(v)) return '[AADHAAR]';
  if (/\bpan\b|\bpan[_-]?(?:no|number|card|id)\b|permanent\s*account/i.test(v)) return '[PAN]';
  if (/e[- ]?mail|email/i.test(v)) return '[EMAIL]';
  if (/password|passcode|pin\s*code/i.test(v)) return '[PASSWORD]';
  if (/credit|debit|payment|card\b|upi|bank\s*account/i.test(v)) return '[PAYMENT]';
  if (/phone|mobile|telephone|contact\s*(?:no|number)/i.test(v) || /\btel\b/i.test(v)) return '[PHONE]';
  if (/address|street|locality|city|state|postal|pincode|zip/i.test(v)) return '[ADDRESS]';
  // A name is classified only when an explicit DOM hint says so. This is not NER.
  if (/full\s*name|first\s*name|last\s*name|given\s*name|surname|\bname\b/i.test(v)) return '[PERSON_NAME]';
  return undefined;
};

const safeWord = (s: string, word: string) => new RegExp(`(?:^|\\b)${word}(?:\\b|$)`, 'i').test(s.trim());

/** Return an enum label from local DOM metadata. No hint is returned to callers. */
export function classifyDomHints(hints: DomHints): Label {
  const values = [hints.type, hints.autocomplete, hints.name, hints.id, hints.placeholder, hints.ariaLabel, hints.text]
    .filter((x): x is string => typeof x === 'string').join(' ').slice(0, 1000);
  const kind = hints.kind;
  const type = (hints.type || '').toLowerCase();
  if (kind === 'image') return '[IMAGE]';
  // Free-standing page prose is never interpreted as identity-bearing NER.
  // Its only outbound representation is the private enum.
  if (kind === 'text') return values.trim() ? '[PRIVATE_TEXT]' : 'TEXT';
  if (kind === 'button') {
    const rendered=(hints.text || hints.ariaLabel || '').trim().toUpperCase();
    const allowed:Label[]=['CONTINUE','NEXT','REVIEW','BACK','CANCEL','SUBMIT','SAVE'];
    return allowed.includes(rendered as Label) ? rendered as Label : '[PRIVATE_TEXT]';
  }
  const pii = privateLabel(values);
  if (pii) return pii;
  if (kind === 'checkbox' || type === 'checkbox') return 'CHECKBOX';
  if (kind === 'select') return 'SELECT';
  if (type === 'search' || safeWord(values, 'search')) return 'SEARCH';
  if (safeWord(values, 'continue')) return 'CONTINUE';
  if (safeWord(values, 'next')) return 'NEXT';
  if (safeWord(values, 'review')) return 'REVIEW';
  if (safeWord(values, 'back')) return 'BACK';
  if (safeWord(values, 'cancel')) return 'CANCEL';
  if (safeWord(values, 'submit')) return 'SUBMIT';
  if (safeWord(values, 'save')) return 'SAVE';
  if (kind === 'input' || kind === 'select' || kind === 'checkbox') return 'FIELD';
  if (kind === 'text' && !values.trim()) return 'TEXT';
  if (kind === 'text') return '[PRIVATE_TEXT]';
  if (kind === 'link' && !values.trim()) return 'TEXT';
  return '[PRIVATE_TEXT]';
};

/**
 * Replace only syntactically recognisable sensitive values for local/demo display.
 * This deliberately does not perform name NER: ordinary names and prose remain
 * untouched because guessing identity is unsafe.
 */
export function replaceSensitive(input: string): string {
  if (typeof input !== 'string') throw new TypeError('text required');
  // Normalize common Indian numeral scripts locally before format matching.
  let out = input.replace(/[०-९০-৯૦-૯੦-੯௦-௯౦-౯೦-೯൦-൯]/g, c => {
    const code=c.charCodeAt(0);for(const zero of [0x0966,0x09e6,0x0ae6,0x0a66,0x0be6,0x0c66,0x0ce6,0x0d66])if(code>=zero&&code<=zero+9)return String(code-zero);return c;
  });
  // Explicit key/value forms are the only name, address, and password handling;
  // values are bounded so a whole page cannot accidentally be consumed.
  out = out.replace(/(password|passcode)\s*[:=]\s*[^,;\n]{1,160}/gi, '$1: [PASSWORD]');
  out = out.replace(/((?:full\s*)?name)\s*[:=]\s*[^,;\n]{1,120}/gi, '$1: [PERSON_NAME]');
  out = out.replace(/address\s*[:=]\s*[^;\n]{1,240}/gi, 'address: [ADDRESS]');
  // India-specific Aadhaar: 12 digits, optionally grouped by spaces/hyphens.
  out = out.replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[AADHAAR]');
  // PAN is five letters, four digits, one letter (case insensitive).
  out = out.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, '[PAN]');
  // Indian mobile numbers (10 digits, starts with 6-9).
  // Handles: +91 prefix, 0 prefix, spaces, hyphens, compact.
  // Groupings: XXXXX-XXXXX, XXXX-XXX-XXX, XXXXXXXXXX, +91 XXXXX XXXXX
  out = out.replace(/(\+91[-\s]?|(?:^|(?<=[\s:,]))\s*0[-\s]?)?([6-9]\d{4}[-\s]?\d{3}[-\s]?\d{2}|\b[6-9]\d{9}\b|[6-9]\d{3}[-\s]\d{3}[-\s]\d{3})/g, '[PHONE]');
  // Email syntax, intentionally bounded and without exposing the address.
  out = out.replace(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi, '[EMAIL]');
  return out;
}

export const redactSensitive = replaceSensitive;
// Descriptive aliases keep the small API convenient for content-script callers.
export const classifyDomHint = classifyDomHints;
export const classifyLabel = classifyDomHints;
