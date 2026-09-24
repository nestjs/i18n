import type {
  LocaleResolverInput,
} from '../interfaces/locale-resolver-input.interface.js';
import { first } from '../utils/request.util.js';
import { LocaleResolver } from './locale.resolver.js';

/** `?lang=pl`. The query parameter name defaults to `lang`. */
export class QueryLocaleResolver extends LocaleResolver {
  constructor(private readonly param = 'lang') {
    super();
  }

  resolve({ query }: LocaleResolverInput) {
    return first(query[this.param]);
  }
}
