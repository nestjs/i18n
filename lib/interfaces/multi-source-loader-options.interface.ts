import type { I18nLoader } from '../loaders/i18n.loader.js';

export interface MultiSourceI18nLoaderOptions {
  /**
   * Loaders whose catalogs are merged, in order.
   * Later loaders override earlier ones.
   */
  loaders: ReadonlyArray<I18nLoader>;
}
