import type {
  I18nCatalogs,
} from '../interfaces/i18n-module-options.interface.js';

/**
 * Where catalogs come from. Also the injection token of the configured
 * loader, so tests can swap it:
 * `overrideProvider(I18nLoader).useValue(new InMemoryI18nLoader({...}))`.
 */
export abstract class I18nLoader {
  /** Every locale's catalog, keyed by locale. Called once, at startup. */
  abstract load(): I18nCatalogs | Promise<I18nCatalogs>;

  /**
   * Optional hot reload: call `onChange` with a complete new set of catalogs
   * whenever the source changes, and return a function that stops watching.
   * Started when the module initializes, stopped when it's destroyed.
   * `onChange` never throws: catalogs that don't fit (no catalog for
   * `defaultLocale`, a malformed locale) are logged and dropped.
   */
  watch?(onChange: (catalogs: I18nCatalogs) => void): () => void;
}
