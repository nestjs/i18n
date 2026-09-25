import { Injectable } from '@nestjs/common';
import { I18nService } from '../i18n.service.js';
import { changeLocale, i18nStorage } from './i18n.storage.js';

/**
 * The locale of the current request (or message, or `run()` call). Backed by
 * an `AsyncLocalStorage` store that the module enters for every request, so
 * singleton providers read the right locale without the request object.
 */
@Injectable()
export class I18nContext {
  constructor(private readonly i18n: I18nService) {}

  /** The current locale, or `defaultLocale` outside a request. */
  get locale(): string {
    return i18nStorage.getStore()?.locale ?? this.i18n.defaultLocale;
  }

  /**
   * Runs `fn` with `locale` as the current locale, matched the way a request
   * locale is: `pl-PL` → `pl`, and an unsupported, missing or malformed
   * locale (a profile that never set one) → `defaultLocale`.
   * For code outside a request: jobs, message consumers, tests.
   */
  run<R>(locale: string | null | undefined, fn: () => R): R {
    return i18nStorage.run(
      {
        locale: (locale != null && this.i18n.matchLocale(locale)) || this.i18n.defaultLocale,
        service: this.i18n,
      },
      fn,
    );
  }

  /**
   * Changes the locale for the rest of the current request, for example to
   * answer in the language a customer has just picked. `locale` is matched
   * the way a resolver's candidate is (`pl-PL` → `pl`). Returns the match,
   * or `undefined` for an unsupported, missing or malformed locale, which
   * leaves the locale as it was. Updates `Content-Language` unless the
   * response headers are already sent.
   *
   * Throws outside a locale context. On microservices, WebSocket gateways and
   * GraphQL subscriptions, the context starts after guards, so call it from
   * the handler (or read the saved locale with an `afterGuards` resolver).
   */
  setLocale(locale: string | null | undefined): string | undefined {
    const store = i18nStorage.getStore();
    if (!store) {
      throw new Error(
        'I18nContext.setLocale() was called outside a locale context. Guards of microservices, ' +
          'WebSocket gateways and GraphQL subscriptions run before the locale is resolved: call it ' +
          'from the handler, or return the locale from a resolver with afterGuards set ' +
          '(https://docs.nestjs.com/application/i18n#use-the-customers-saved-language). ' +
          'Outside a request, use I18nContext.run().',
      );
    }

    const match = locale != null ? this.i18n.matchLocale(locale) : undefined;
    if (match) {
      // An explicit choice wins over the afterGuards resolvers still to run.
      store.pending = undefined;
      changeLocale(store, match);
    }
    return match;
  }
}
