export interface I18nTranslateOptions {
  /** Placeholder values; a numeric `count` also selects the plural form. */
  args?: Record<string, unknown>;
  /**
   * Explicit locale, matched like a request locale (`pl-PL` → `pl`; an
   * unsupported one → `defaultLocale`). When omitted, the current locale.
   */
  locale?: string;
}

export type I18nNumberFormatOptions = Intl.NumberFormatOptions & {
  /**
   * Explicit locale, matched like a request locale (`pl-PL` → `pl`; an
   * unsupported one → `defaultLocale`). When omitted, the current locale.
   */
  locale?: string;
};

export type I18nDateFormatOptions = Intl.DateTimeFormatOptions & {
  /**
   * Explicit locale, matched like a request locale (`pl-PL` → `pl`; an
   * unsupported one → `defaultLocale`). When omitted, the current locale.
   */
  locale?: string;
};
