import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { i18nStorage } from './context/i18n.storage.js';
import { I18nMissingKeyError } from './errors/i18n-missing-key.error.js';
import { I18N_CATALOGS, I18N_MODULE_OPTIONS } from './i18n.constants.js';
import type {
  I18nKey,
  I18nRegisteredTranslations,
  I18nTranslateArgs,
} from './interfaces/i18n-keys.interface.js';
import type {
  I18nCatalog,
  I18nCatalogs,
  I18nModuleOptions,
} from './interfaces/i18n-module-options.interface.js';
import type {
  I18nDateFormatOptions,
  I18nNumberFormatOptions,
  I18nTranslateOptions,
} from './interfaces/i18n-translate-options.interface.js';
import { I18nLoader } from './loaders/i18n.loader.js';
import {
  isLocaleTag,
  parentTag,
  suggestLocaleTag,
} from './utils/locale-tags.util.js';
import { quote } from './utils/quote.util.js';

/** Distinct missing keys remembered for `logMissingKeys: 'once'`. */
const MAX_WARNED_KEYS = 10_000;

/** `Intl` formatters kept per locale and options (each takes 10-40 µs to build). */
const MAX_FORMATTERS = 500;

/** The locales a translation in one locale reads (internal). */
interface Chain {
  /** Where the lookup goes, in order, under the missing-key policy. */
  readonly lookup: readonly string[];
  /** The locale's own chain: a message found anywhere else is a fallback. */
  readonly own: ReadonlySet<string>;
}

/**
 * Translates keys and formats values for the current locale (the request's,
 * see `I18nContext`) or for an explicit `locale`.
 *
 * Keys are checked against the catalog shape registered on `I18nTypes`. `T`
 * overrides it for one injection site: `I18nService<OtherTranslations>`.
 */
@Injectable()
export class I18nService<T = I18nRegisteredTranslations>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('I18nService');
  private readonly warnedKeys = new Set<string>();
  private readonly pluralRules = new Map<string, Intl.PluralRules>();
  private readonly formatters = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
  private readonly defaultLocaleValue: string;
  private supported: string[] = [];
  /** Lower-cased locale → its configured spelling: supported locales and `fallbacks` keys. */
  private lookup = new Map<string, string>();
  /** The longest `lookup` key: no longer prefix of a candidate can match. */
  private longest = 0;
  private chains = new Map<string, Chain>();
  private stopWatching?: () => void;

  constructor(
    @Inject(I18N_MODULE_OPTIONS) private readonly options: I18nModuleOptions,
    @Inject(I18N_CATALOGS) private catalogs: I18nCatalogs,
    private readonly loader: I18nLoader,
  ) {
    this.defaultLocaleValue = options.defaultLocale ?? 'en';
    checkOptions(options, this.defaultLocaleValue);
    this.index(catalogs);
  }

  onModuleInit() {
    this.stopWatching = this.loader.watch?.((next) => this.reload(next));
  }

  onModuleDestroy() {
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  get defaultLocale(): string {
    return this.defaultLocaleValue;
  }

  /**
   * The locales a request can get: the catalog (or pinned) locales,
   * `defaultLocale` and the `fallbacks` keys. For a language picker.
   */
  get supportedLocales(): readonly string[] {
    return this.supported;
  }

  /**
   * Translates `key` for the current locale, or for `options.locale`.
   * A plural message needs a numeric `args.count`, which picks the form.
   */
  t<K extends I18nKey<T>>(key: K, ...[options]: I18nTranslateArgs<T, K>): string {
    return this.translate(key as string, options);
  }

  /** `t()` with an unchecked key, for keys built at runtime. */
  translate(key: string, options: I18nTranslateOptions = {}): string {
    const locale = this.localeOf(options.locale);
    const args = options.args ?? {};
    const catalogs = this.catalogs;
    const chain = this.chainOf(locale);

    for (const candidate of chain.lookup) {
      const value = get(catalogs, candidate, key);
      let text: string | undefined;
      if (typeof value === 'string') {
        text = value;
      } else if (value) {
        // Plural forms. Without a numeric count there's no form to pick, so `other`.
        const form = typeof args.count === 'number' ? this.plural(candidate, args.count) : 'other';
        const selected = ownValue(value, form) ?? ownValue(value, 'other');
        if (typeof selected === 'string') {
          text = selected;
        }
      }

      if (text === undefined) {
        continue;
      }

      if (!chain.own.has(candidate)) {
        this.onFallback(key, locale, candidate);
      }
      return interpolate(text, args);
    }

    return this.onMissing(key, locale);
  }

  /**
   * Whether `key` resolves to a message (a string or plural forms) for
   * `locale` (default: the current one) under the missing-key policy.
   */
  exists(key: string, locale?: string): boolean {
    const catalogs = this.catalogs;
    return this.chainOf(this.localeOf(locale)).lookup.some((candidate) => {
      const value = get(catalogs, candidate, key);
      return typeof value === 'string' || typeof ownValue(value, 'other') === 'string';
    });
  }

  /** `Intl.NumberFormat` for the current locale, or for `options.locale`. */
  formatNumber(value: number | bigint, options: I18nNumberFormatOptions = {}): string {
    const { locale, ...intlOptions } = options;
    const resolved = this.localeOf(locale);
    return this.formatter('number', resolved, intlOptions, () =>
      new Intl.NumberFormat(resolved, intlOptions),
    ).format(value);
  }

  /** `Intl.DateTimeFormat` for the current locale, or for `options.locale`. */
  formatDate(value: Date | number, options: I18nDateFormatOptions = {}): string {
    const { locale, ...intlOptions } = options;
    const resolved = this.localeOf(locale);
    return this.formatter('date', resolved, intlOptions, () =>
      new Intl.DateTimeFormat(resolved, intlOptions),
    ).format(value);
  }

  /**
   * Maps a candidate (`pl-PL`, `DE_at`) to a supported locale: an exact
   * match or a `fallbacks` key, then shorter and shorter prefixes
   * (`zh-Hant-TW` → `zh-Hant` → `zh`). `undefined` when none matches, for
   * example to validate a locale a user picks in their profile.
   */
  matchLocale(candidate: string): string | undefined {
    if (typeof candidate !== 'string') {
      return undefined;
    }

    let tag = candidate.trim().replace(/_/g, '-').toLowerCase();
    if (tag.length > this.longest) {
      // Only prefixes as long as a supported locale can match; headers can be long.
      const cut = tag.lastIndexOf('-', this.longest);
      tag = cut === -1 ? '' : tag.slice(0, cut);
    }

    for (; tag; tag = parentTag(tag)) {
      const match = this.lookup.get(tag);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  private get currentLocale(): string {
    return i18nStorage.getStore()?.locale ?? this.defaultLocaleValue;
  }

  /**
   * An explicit locale, matched the way a request locale is (an unsupported
   * one gets `defaultLocale`), or the current locale when there's none. So
   * only supported locales reach the catalogs and `Intl`.
   */
  private localeOf(explicit: string | undefined): string {
    if (!explicit) {
      return this.currentLocale;
    }
    return this.matchLocale(explicit) ?? this.defaultLocaleValue;
  }

  /**
   * Takes catalogs from `I18nLoader.watch()`. Catalogs that don't fit are
   * logged and dropped: throwing would reach the loader's own callback (a
   * file watcher, a polling timer), where nothing catches it.
   */
  private reload(catalogs: I18nCatalogs) {
    try {
      this.replaceCatalogs(catalogs);
      this.logger.log('Reloaded the translations');
    } catch (err) {
      this.logger.error(`Keeping the previous translations: ${(err as Error).message}`);
    }
  }

  /**
   * Swaps the catalogs in one assignment, so a translation in flight reads
   * either the old or the new ones, never a mix.
   */
  private replaceCatalogs(catalogs: I18nCatalogs) {
    this.index(catalogs);
    this.catalogs = catalogs;
    this.warnedKeys.clear();
  }

  /** The chain of a supported locale, computed once per catalog set. */
  private chainOf(locale: string): Chain {
    let chain = this.chains.get(locale);
    if (!chain) {
      const withDefault = (this.options.missingKey ?? 'fallback') === 'fallback';
      chain = {
        lookup: this.chain(locale, withDefault),
        own: new Set(this.chain(locale, false)),
      };
      this.chains.set(locale, chain);
    }
    return chain;
  }

  /**
   * `de-AT` → `['de-AT', 'de', 'en']`: the locale, its explicit `fallbacks`,
   * the supported prefixes of each (`zh-Hant-TW` → `zh-Hant` → `zh`), then,
   * unless `includeDefault` is false, `defaultLocale`.
   */
  private chain(locale: string, includeDefault: boolean, lookup = this.lookup): string[] {
    const chain: string[] = [];
    const push = (l: string | undefined) => {
      if (l && !chain.includes(l)) {
        chain.push(l);
      }
    };

    const fallbacks = this.options.fallbacks ?? {};
    let current: string | undefined = locale;
    while (current && !chain.includes(current)) {
      push(current);
      current = Object.hasOwn(fallbacks, current) ? fallbacks[current] : undefined;
    }

    for (const l of chain.slice()) {
      for (let prefix = parentTag(l.toLowerCase()); prefix; prefix = parentTag(prefix)) {
        push(lookup.get(prefix));
      }
    }

    if (includeDefault) {
      push(this.defaultLocaleValue);
    }
    return chain;
  }

  /** Warns when the `fallback` policy served a message from `defaultLocale`. */
  private onFallback(key: string, locale: string, usedLocale: string) {
    this.warn(
      `fallback:${locale}:${key}`,
      `Missing translation ${quote(key)} for locale ${quote(locale)}; using ${quote(usedLocale)}`,
    );
  }

  private warn(dedupeKey: string, message: string) {
    const log = this.options.logMissingKeys ?? 'once';
    if (log === 'always' || (log === 'once' && !this.warnedKeys.has(dedupeKey))) {
      // Keys built from request input could grow the set without bound.
      if (this.warnedKeys.size >= MAX_WARNED_KEYS) {
        this.warnedKeys.clear();
      }
      this.warnedKeys.add(dedupeKey);
      this.logger.warn(message);
    }
  }

  private onMissing(key: string, locale: string): string {
    this.warn(key, `Missing translation ${quote(key)} (locale ${quote(locale)})`);

    const policy = this.options.missingKey ?? 'fallback';
    if (typeof policy === 'function') {
      return policy(key, locale);
    }
    switch (policy) {
      case 'empty':
        return '';
      case 'throw':
        throw new I18nMissingKeyError(key, locale);
      default:
        return key;
    }
  }

  /** Checks and indexes a set of catalogs. Throws, and changes nothing, when they don't fit. */
  private index(catalogs: I18nCatalogs) {
    const pinned = this.options.supportedLocales;
    if (!pinned) {
      // Every catalog becomes a supported locale, which reaches `Intl` and response headers.
      const invalid = Object.keys(catalogs).find((locale) => !isLocaleTag(locale));
      if (invalid !== undefined) {
        const suggestion = suggestLocaleTag(invalid);
        throw new Error(
          `I18nModule: the loader returned a catalog for ${quote(invalid)}, which isn't a ` +
            (suggestion
              ? `BCP 47 language tag. Rename it to ${quote(suggestion)}, `
              : 'BCP 47 language tag such as "en" or "pt-BR". Rename it, ') +
            'or set supportedLocales to the locales you serve.',
        );
      }
    }

    // Requests can get every catalog (or pinned) locale, `defaultLocale`, and
    // every `fallbacks` key (`de-AT` → `de` keeps `de-AT` as a locale of its own).
    const supported = [...(pinned ?? Object.keys(catalogs))];
    const lookup = new Map<string, string>();
    for (const locale of [
      ...supported,
      this.defaultLocaleValue,
      ...Object.keys(this.options.fallbacks ?? {}),
    ]) {
      if (lookup.has(locale.toLowerCase())) {
        continue;
      }
      lookup.set(locale.toLowerCase(), locale);
      if (!supported.includes(locale)) {
        supported.push(locale);
      }
    }

    const hasCatalog = (locale: string) =>
      this.chain(locale, false, lookup).some((l) => Object.hasOwn(catalogs, l));
    if (!hasCatalog(this.defaultLocaleValue)) {
      const loaded = Object.keys(catalogs);
      throw new Error(
        `I18nModule: there's no catalog for defaultLocale ${quote(this.defaultLocaleValue)}. ` +
          (loaded.length
            ? `The loader returned ${loaded.map(quote).join(', ')}; set defaultLocale to one of them.`
            : 'The loader returned no catalogs.'),
      );
    }

    const untranslated = supported.filter((locale) => !hasCatalog(locale));
    if (untranslated.length) {
      this.logger.warn(
        `supportedLocales without a catalog: ${untranslated.map(quote).join(', ')}. ` +
          'Their messages follow the missingKey policy.',
      );
    }

    this.supported = supported;
    this.lookup = lookup;
    this.longest = Math.max(0, ...[...lookup.keys()].map((l) => l.length));
    this.chains = new Map();
  }

  private plural(locale: string, count: number): Intl.LDMLPluralRule {
    let rules = this.pluralRules.get(locale);
    if (!rules) {
      rules = new Intl.PluralRules(locale);
      this.pluralRules.set(locale, rules);
    }

    return rules.select(count);
  }

  private formatter<F extends Intl.NumberFormat | Intl.DateTimeFormat>(
    kind: 'number' | 'date',
    locale: string,
    options: object,
    create: () => F,
  ): F {
    const key = `${kind}|${locale}|${JSON.stringify(options)}`;
    let formatter = this.formatters.get(key) as F | undefined;
    if (!formatter) {
      formatter = create();
      if (this.formatters.size >= MAX_FORMATTERS) {
        this.formatters.delete(this.formatters.keys().next().value!);
      }
      this.formatters.set(key, formatter);
    }
    return formatter;
  }
}

const MISSING_KEY_POLICIES = ['fallback', 'key', 'empty', 'throw'];
const LOG_MISSING_KEYS = ['once', 'always', 'never'];

/**
 * Fails at startup on options that would misbehave at request time: a locale
 * `Intl` rejects (and a `Content-Language` header can't carry), or a policy
 * name with a typo, typically read from an environment variable.
 */
function checkOptions(options: I18nModuleOptions, defaultLocale: string) {
  const { missingKey, logMissingKeys } = options;
  if (
    missingKey !== undefined &&
    typeof missingKey !== 'function' &&
    !MISSING_KEY_POLICIES.includes(missingKey)
  ) {
    throw new Error(
      `I18nModule: missingKey is ${JSON.stringify(missingKey)}; ` +
        "use 'fallback', 'key', 'empty', 'throw' or a function.",
    );
  }

  if (logMissingKeys !== undefined && !LOG_MISSING_KEYS.includes(logMissingKeys)) {
    throw new Error(
      `I18nModule: logMissingKeys is ${JSON.stringify(logMissingKeys)}; use 'once', 'always' or 'never'.`,
    );
  }

  const useInstead = (locale: string) => {
    const suggestion = suggestLocaleTag(locale);
    return suggestion ? `. Use ${quote(suggestion)}.` : ' such as "en" or "pt-BR".';
  };
  if (!isLocaleTag(defaultLocale)) {
    throw new Error(
      `I18nModule: defaultLocale ${quote(defaultLocale)} isn't a BCP 47 language tag` +
        useInstead(defaultLocale),
    );
  }

  const configured: [string, string][] = [
    ...(options.supportedLocales ?? []).map((l): [string, string] => ['supportedLocales', l]),
    ...Object.entries(options.fallbacks ?? {}).flatMap(([from, to]): [string, string][] => [
      ['fallbacks', from],
      ['fallbacks', to],
    ]),
  ];

  for (const [option, locale] of configured) {
    if (isLocaleTag(locale)) {
      continue;
    }
    throw new Error(
      `I18nModule: ${option} has ${quote(locale)}, which isn't a BCP 47 language tag` +
        useInstead(locale),
    );
  }
}

/** `node[key]` when `node` is an object that has `key` itself, not through its prototype. */
function ownValue(node: unknown, key: string): unknown {
  return node !== null && typeof node === 'object' && Object.hasOwn(node, key)
    ? (node as Record<string, unknown>)[key]
    : undefined;
}

function get(
  catalogs: I18nCatalogs,
  locale: string,
  key: string,
): string | I18nCatalog | undefined {
  let node = ownValue(catalogs, locale);
  for (const part of key.split('.')) {
    if (!node || typeof node === 'string') {
      return undefined;
    }
    node = ownValue(node, part);
  }
  return node as string | I18nCatalog | undefined;
}

function interpolate(text: string, args: Record<string, unknown>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(args, name) ? toText(args[name]) : match,
  );
}

/** `String(value)`, except that it never throws (a null-prototype object has no string form). */
function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
