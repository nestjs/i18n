import type {
  LocaleResolverInput,
} from '../interfaces/locale-resolver-input.interface.js';
import { first } from '../utils/request.util.js';
import { LocaleResolver } from './locale.resolver.js';

/** `Accept-Language: de;q=0.3, pl-PL;q=0.9` → `['pl-PL', 'de']`. */
export class AcceptLanguageLocaleResolver extends LocaleResolver {
  readonly varyHeaders: readonly string[] = ['Accept-Language'];

  resolve({ headers }: LocaleResolverInput) {
    const header = first(headers['accept-language']);
    return header ? parseAcceptLanguage(header) : undefined;
  }
}

/**
 * Language tags ordered by q-value (header order on ties), without `*` and
 * `q=0`. A malformed weight counts as 0.
 */
export function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      let q = 1;
      for (const param of params) {
        const [name, value] = param.split('=');
        // The parameter name is case-insensitive (RFC 9110): `Q=0.5` counts.
        if (name.trim().toLowerCase() === 'q') {
          q = Number(value);
        }
      }
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter(({ tag, q }) => tag && tag !== '*' && q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map(({ tag }) => tag);
}
