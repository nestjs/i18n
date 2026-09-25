import { AsyncLocalStorage } from 'node:async_hooks';
import type { I18nService } from '../i18n.service.js';
import type { LocaleResolver } from '../resolvers/locale.resolver.js';

/** What the module keeps per request (internal). */
export interface I18nStore {
  locale: string;
  /** Lets code without DI (`t()`, validation messages) reach the catalogs. */
  service: I18nService<any>;
  /**
   * `afterGuards` resolvers that rank above the locale the middleware found.
   * The interceptor runs them once guards have run; `settled` makes the
   * concurrent calls of one request (GraphQL root fields) share one run.
   */
  pending?: { resolvers: LocaleResolver[]; settled?: Promise<void> };
  /** Keeps `Content-Language` in step when the locale changes after the middleware. */
  onChange?: (locale: string) => void;
}

/** One store for the package. `I18nContext` is its public face. */
export const i18nStorage = new AsyncLocalStorage<I18nStore>();

/** Makes `locale`, a supported locale, the store's locale for the rest of the call. */
export function changeLocale(store: I18nStore, locale: string) {
  if (store.locale === locale) {
    return;
  }

  store.locale = locale;
  store.onChange?.(locale);
}
