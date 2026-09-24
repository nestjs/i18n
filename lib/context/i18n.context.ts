import { Injectable } from '@nestjs/common';
import { I18nService } from '../i18n.service.js';
import { i18nStorage } from './i18n.storage.js';

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
}
