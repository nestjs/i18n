import {
  I18nModule,
  InMemoryI18nLoader,
  LocaleResolver,
  t,
  type I18nContext,
  type I18nKey,
  type I18nModuleOptions,
  type I18nService,
} from '../lib/index.js';
import type { I18nPluralPath } from '../lib/interfaces/i18n-keys.interface.js';
import type { AppTranslations } from './app.js';

// Type-level assertions; `tsc --noEmit` fails if any @ts-expect-error is unused.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(value: T) => value;

interface Shop {
  cart: {
    empty: string;
    items: { one: string; other: string };
    // plural-looking, but with a key that is no plural category: a namespace
    sizes: { one: string; other: string; xl: string };
    // only `other` is required for plural forms
    total: { other: string };
    deep: { nested: { title: string } };
  };
}

describe('key types', () => {
  it('derive leaves, plural messages and namespaces from the catalog shape', () => {
    assertType<
      Equal<
        I18nKey<Shop>,
        | 'cart.empty'
        | 'cart.items'
        | 'cart.sizes.one'
        | 'cart.sizes.other'
        | 'cart.sizes.xl'
        | 'cart.total'
        | 'cart.deep.nested.title'
      >
    >(true);
    assertType<Equal<I18nPluralPath<Shop>, 'cart.items' | 'cart.total'>>(true);
    assertType<Equal<I18nKey, string>>(true);
  });

  it('require a numeric count for plural messages only', () => {
    const check = (i18n: I18nService<Shop>) => {
      i18n.t('cart.total', { args: { count: 3 } });
      i18n.t('cart.sizes.xl');
      i18n.t('cart.empty', { locale: 'pl' });
      // @ts-expect-error a plural message needs a count
      i18n.t('cart.total', { locale: 'pl' });
      // @ts-expect-error a plural message needs a count
      i18n.t('cart.items', { args: {} });
      t<Shop>('cart.items', { args: { count: 1, extra: 'ok' } });
      // @ts-expect-error namespaces are not keys
      t<Shop>('cart.deep');
    };
    expect(typeof check).toBe('function');
  });

  it('type the rest of the public API', () => {
    const check = async (i18n: I18nService<AppTranslations>, context: I18nContext) => {
      const n: number = context.run('pl', () => 1);
      const p: Promise<string> = context.run(undefined, async () => 'x');
      const exists: boolean = i18n.exists('dynamic.key', 'pl');
      const matched: string | undefined = i18n.matchLocale('pl-PL');
      const locales: readonly string[] = i18n.supportedLocales;
      i18n.formatNumber(10n, { locale: 'pl', style: 'decimal' });
      i18n.formatDate(Date.now(), { dateStyle: 'short' });
      // @ts-expect-error formatDate takes a Date or a timestamp
      i18n.formatDate('2026-01-01');
      // @ts-expect-error supportedLocales is read-only
      i18n.supportedLocales.push('fr');
      return [n, await p, exists, matched, locales];
    };
    expect(typeof check).toBe('function');
  });

  it('type the options and extension points', () => {
    const options: I18nModuleOptions[] = [
      { missingKey: (key: string, locale: string) => `${locale}:${key}` },
      { missingKey: 'throw', logMissingKeys: 'always', responseHeaders: false },
      // @ts-expect-error unknown policy
      { missingKey: 'ignore' },
      // @ts-expect-error unknown log setting
      { logMissingKeys: 'sometimes' },
    ];

    class AsyncResolver extends LocaleResolver {
      async resolve() {
        return ['pl', 'de'];
      }
    }
    class WrongResolver extends LocaleResolver {
      // @ts-expect-error a resolver returns locale strings
      resolve() {
        return 42;
      }
    }
    const modules = () => [
      I18nModule.forRoot({ loader: new InMemoryI18nLoader({ en: {} }), resolvers: [AsyncResolver] }),
      // @ts-expect-error catalogs hold strings and nested catalogs
      new InMemoryI18nLoader({ en: { count: 1 } }),
    ];
    expect(options).toHaveLength(4);
    expect(typeof modules).toBe('function');
    expect(WrongResolver).toBeDefined();
  });
});
