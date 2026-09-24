import type {
  LocaleResolverInput,
} from '../interfaces/locale-resolver-input.interface.js';
import { first } from '../utils/request.util.js';
import { LocaleResolver } from './locale.resolver.js';

/** `Cookie: lang=pl`. The cookie name defaults to `lang`. */
export class CookieLocaleResolver extends LocaleResolver {
  readonly varyHeaders: readonly string[] = ['Cookie'];

  constructor(private readonly name = 'lang') {
    super();
  }

  resolve({ headers }: LocaleResolverInput) {
    return readCookie(first(headers.cookie), this.name);
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1 || pair.slice(0, eq).trim() !== name) {
      continue;
    }

    let value = pair.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }

  return undefined;
}
