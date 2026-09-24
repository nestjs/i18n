/** Whether `tag` is a well-formed BCP 47 language tag, so `Intl` accepts it. */
export function isLocaleTag(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

/**
 * A valid spelling of a malformed tag (`pt_BR` → `pt-BR`), or `undefined`
 * when there is none to suggest.
 */
export function suggestLocaleTag(tag: string): string | undefined {
  const candidate = tag.trim().replace(/_/g, '-');
  return isLocaleTag(candidate) ? Intl.getCanonicalLocales(candidate)[0] : undefined;
}

/**
 * The next shorter tag in an RFC 4647 lookup, lower-cased input assumed:
 * `zh-hant-tw` → `zh-hant` → `zh` → `''`. A trailing singleton (`x`, `u`)
 * goes together with the subtag after it: `sr-latn-x-foo` → `sr-latn`.
 */
export function parentTag(tag: string): string {
  const end = tag.lastIndexOf('-');
  if (end === -1) {
    return '';
  }
  const parent = tag.slice(0, end);
  const last = parent.lastIndexOf('-');
  return last !== -1 && parent.length - last === 2 ? parent.slice(0, last) : parent;
}
