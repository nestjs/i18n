import { quote } from '../utils/quote.util.js';

/** Thrown for a missing translation under the `missingKey: 'throw'` policy. */
export class I18nMissingKeyError extends Error {
  constructor(
    readonly key: string,
    readonly locale: string,
  ) {
    super(`Missing translation ${quote(key)} for locale ${quote(locale)}`);
    this.name = 'I18nMissingKeyError';
  }
}
