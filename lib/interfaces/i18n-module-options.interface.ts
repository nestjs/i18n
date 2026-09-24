import type { I18nLoader } from '../loaders/i18n.loader.js';
import type { LocaleResolver } from '../resolvers/locale.resolver.js';

/** One locale's messages: `{ orders: { notFound: '...' } }`. */
export interface I18nCatalog {
  [key: string]: string | I18nCatalog;
}

/** Catalogs keyed by locale: `{ en: {...}, pl: {...} }`. */
export type I18nCatalogs = Record<string, I18nCatalog>;

/**
 * What to do when a key is missing from the requested locale's chain.
 * - `fallback` (default): also try `defaultLocale` (and warn, per
 *   `logMissingKeys`), then return the key
 * - `key`: return the key (no default-locale fallback)
 * - `empty`: return `''`
 * - `throw`: throw `I18nMissingKeyError`
 * - function: return whatever it returns
 * Explicit `fallbacks` and base-language fallback (`de-AT` → `de`) apply in
 * every mode; only the jump to `defaultLocale` is policy-controlled.
 */
export type I18nMissingKeyPolicy =
  | 'fallback'
  | 'key'
  | 'empty'
  | 'throw'
  | ((key: string, locale: string) => string);

/**
 * What `forRootAsync()`'s factory returns, and what `forRoot()` takes next to
 * its top-level options. The factory can return `loader` and `resolvers`
 * instances built from injected configuration. Classes that Nest
 * instantiates go at the top level of `forRoot()` and `forRootAsync()`.
 */
export interface I18nModuleOptions {
  /**
   * Where catalogs come from, such as `new JsonI18nLoader({ path })`.
   * Required, here or at the top level.
   */
  loader?: I18nLoader;
  /** Locale resolvers, tried in order. Default `[new AcceptLanguageLocaleResolver()]`. */
  resolvers?: LocaleResolver[];
  /** Used when no resolver finds a supported locale, and outside requests. Default `'en'`. */
  defaultLocale?: string;
  /**
   * The locales requests can get, as BCP 47 tags (`pl`, `de-AT`). Defaults to
   * the locales the loader returned.
   */
  supportedLocales?: string[];
  /** Explicit fallbacks, e.g. `{ 'de-AT': 'de' }`. Keys count as supported. */
  fallbacks?: Record<string, string>;
  /** Default `'fallback'`. */
  missingKey?: I18nMissingKeyPolicy;
  /**
   * Warn when a key is missing everywhere, and when the `fallback` policy
   * serves a message from `defaultLocale`. Default `'once'` (per key, and per
   * key and locale for fallbacks).
   */
  logMissingKeys?: 'once' | 'always' | 'never';
  /**
   * Set `Content-Language` (the resolved locale) and `Vary` (the headers the
   * resolvers read) on HTTP responses. Default `true`.
   */
  responseHeaders?: boolean;
}
