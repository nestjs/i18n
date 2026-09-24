import type {
  LocaleResolverInput,
} from '../interfaces/locale-resolver-input.interface.js';
import { first } from '../utils/request.util.js';
import { LocaleResolver } from './locale.resolver.js';

/** `x-lang: pl`. The header name defaults to `x-lang`. */
export class HeaderLocaleResolver extends LocaleResolver {
  readonly varyHeaders: readonly string[];
  private readonly header: string;

  constructor(header = 'x-lang') {
    super();
    this.header = header.toLowerCase();
    this.varyHeaders = [header];
  }

  resolve({ headers }: LocaleResolverInput) {
    return first(headers[this.header]);
  }
}
