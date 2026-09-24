import { AsyncLocalStorage } from 'node:async_hooks';
import type { I18nService } from '../i18n.service.js';

/** What the module keeps per request (internal). */
export interface I18nStore {
  locale: string;
  /** Lets code without DI (`t()`, validation messages) reach the catalogs. */
  service: I18nService<any>;
}

/** One store for the package. `I18nContext` is its public face. */
export const i18nStorage = new AsyncLocalStorage<I18nStore>();
