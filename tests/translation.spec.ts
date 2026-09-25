import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  I18nContext,
  I18nLoader,
  I18nMissingKeyError,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  type I18nCatalogs,
  type I18nForRootOptions,
} from '../lib/index.js';

async function create(options: I18nForRootOptions) {
  const ref = await Test.createTestingModule({ imports: [I18nModule.forRoot(options)] }).compile();
  return { i18n: ref.get(I18nService), context: ref.get(I18nContext), ref };
}

describe('translation', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  describe('lookup', () => {
    let i18n: I18nService;

    beforeAll(async () => {
      ({ i18n } = await create({
        loader: new InMemoryI18nLoader({
          en: {
            hi: 'Hi',
            users: { title: 'Users', apples: { one: '{count} apple', other: '{count} apples' } },
            // a plural form English never selects, to tell whose rules picked the form
            products: { one: '{count} product', few: 'FEW', other: '{count} products' },
            broken: { one: 'one', other: 'other' },
          },
          pl: {
            hi: 'Cześć',
            users: { apples: { one: '{count} jabłko', other: '{count} jabłek' } },
            // malformed: no `other` form
            broken: { one: 'jeden' },
          },
        }),
      }));
    });

    it('treats a namespace as a missing key, not as a message', () => {
      expect(i18n.translate('users')).toBe('users');
      expect(i18n.exists('users')).toBe(false);
      expect(i18n.exists('users.title')).toBe(true);
    });

    it('treats a path through a string as a missing key', () => {
      expect(i18n.translate('hi.there')).toBe('hi.there');
      expect(i18n.exists('hi.there')).toBe(false);
    });

    it('uses "other" when the catalog lacks the selected plural form', () => {
      // 5 is "many" in Polish; the catalog only has one and other
      expect(i18n.translate('users.apples', { locale: 'pl', args: { count: 5 } })).toBe('5 jabłek');
      expect(i18n.translate('users.apples', { locale: 'pl', args: { count: 1 } })).toBe('1 jabłko');
    });

    it('selects plural forms with the rules of the locale the message comes from', () => {
      // "products" comes from en: 2 is "other" in English, although it's "few" in Polish
      expect(i18n.translate('products', { locale: 'pl', args: { count: 2 } })).toBe('2 products');
    });

    it('moves on to the next locale when plural forms have neither the selected form nor "other"', () => {
      expect(i18n.translate('broken', { locale: 'pl', args: { count: 1 } })).toBe('jeden');
      expect(i18n.translate('broken', { locale: 'pl', args: { count: 5 } })).toBe('other');
    });

    it('selects "other" for a count that is not a number, and still interpolates it', () => {
      expect(i18n.translate('users.apples', { args: { count: '1' } })).toBe('1 apples');
    });

    it('reports plural messages as existing', () => {
      expect(i18n.exists('users.apples', 'pl')).toBe(true);
      expect(i18n.exists('users.nope', 'pl')).toBe(false);
    });
  });

  describe('interpolation', () => {
    let i18n: I18nService;

    beforeAll(async () => {
      ({ i18n } = await create({
        loader: new InMemoryI18nLoader({
          en: {
            twice: '{name} and {name}',
            positional: '{0} of {1}',
            odd: '{a-b} { name } {}',
            one: '{a}',
          },
        }),
      }));
    });

    it('replaces every occurrence of a placeholder, including numeric names', () => {
      expect(i18n.translate('twice', { args: { name: 'Ada' } })).toBe('Ada and Ada');
      expect(i18n.translate('positional', { args: { 0: 3, 1: 10 } })).toBe('3 of 10');
    });

    it('leaves braces that are not placeholders alone', () => {
      expect(i18n.translate('odd', { args: { 'a-b': 'x', name: 'y', '': 'z' } })).toBe('{a-b} { name } {}');
    });

    it('renders null and undefined arguments as text', () => {
      expect(i18n.translate('one', { args: { a: null } })).toBe('null');
      expect(i18n.translate('one', { args: { a: undefined } })).toBe('undefined');
    });

    it('does not interpolate placeholders that come from argument values', () => {
      expect(i18n.translate('one', { args: { a: '{b}', b: 'injected' } })).toBe('{b}');
    });
  });

  describe('explicit fallbacks', () => {
    const catalogs = {
      en: { a: 'en-a', b: 'en-b', c: 'en-c' },
      de: { a: 'de-a' },
      'de-CH': { b: 'ch-b' },
      es: { hi: 'Hola' },
    };

    it('follow several hops, then base languages, then the default locale', async () => {
      const { i18n } = await create({
        loader: new InMemoryI18nLoader(catalogs),
        fallbacks: { 'de-AT': 'de-CH' },
      });
      expect(i18n.translate('b', { locale: 'de-AT' })).toBe('ch-b');
      expect(i18n.translate('a', { locale: 'de-AT' })).toBe('de-a');
      expect(warn).not.toHaveBeenCalled();

      expect(i18n.translate('c', { locale: 'de-AT' })).toBe('en-c');
      expect(warn.mock.calls.map(([message]: unknown[]) => message)).toEqual([
        'Missing translation "c" for locale "de-AT"; using "en"',
      ]);
    });

    it('stop at a cycle', async () => {
      const { i18n } = await create({
        loader: new InMemoryI18nLoader(catalogs),
        fallbacks: { 'de-AT': 'de-CH', 'de-CH': 'de-AT' },
      });
      expect(i18n.translate('b', { locale: 'de-AT' })).toBe('ch-b');
      expect(i18n.translate('a', { locale: 'de-CH' })).toBe('de-a');
    });

    it('can point to another language, and apply under the "key" policy too', async () => {
      const { i18n } = await create({
        loader: new InMemoryI18nLoader(catalogs),
        fallbacks: { pt: 'es' },
        missingKey: 'key',
      });
      expect(i18n.matchLocale('pt-BR')).toBe('pt');
      expect(i18n.translate('hi', { locale: 'pt-BR' })).toBe('Hola');
      expect(i18n.translate('a', { locale: 'pt' })).toBe('a');
    });
  });

  describe('missing keys', () => {
    it('a missingKey function gets the key and the matched locale', async () => {
      const { i18n, context } = await create({
        loader: new InMemoryI18nLoader({ en: {}, pl: {} }),
        missingKey: (key, locale) => `${locale}:${key}`,
      });
      expect(i18n.translate('x', { locale: 'pl-PL' })).toBe('pl:x');
      expect(i18n.translate('x', { locale: 'fr' })).toBe('en:x');
      expect(context.run('PL', () => i18n.translate('x'))).toBe('pl:x');
    });

    it('I18nMissingKeyError carries the key and the locale', async () => {
      const { i18n } = await create({
        loader: new InMemoryI18nLoader({ en: {}, pl: {} }),
        missingKey: 'throw',
      });
      let error: unknown;
      try {
        i18n.translate('orders.none', { locale: 'pl-PL' });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(I18nMissingKeyError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: 'I18nMissingKeyError',
        key: 'orders.none',
        locale: 'pl',
        message: 'Missing translation "orders.none" for locale "pl"',
      });
    });

    it('warn again after a reload', async () => {
      let deliver: (catalogs: I18nCatalogs) => void = () => {};
      class WatchedLoader extends I18nLoader {
        load() {
          return { en: {} };
        }
        watch(onChange: (catalogs: I18nCatalogs) => void) {
          deliver = onChange;
          return () => {};
        }
      }
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      try {
        const { i18n, ref } = await create({ loader: new WatchedLoader() });
        await ref.init();
        i18n.translate('nope');
        i18n.translate('nope');
        expect(warn).toHaveBeenCalledTimes(1);

        deliver({ en: { other: 'x' } });
        i18n.translate('nope');
        expect(warn).toHaveBeenCalledTimes(2);
        await ref.close();
      } finally {
        log.mockRestore();
      }
    });

    it('"once" forgets every key after 10 000 distinct ones, so keys from requests cannot grow memory', async () => {
      const { i18n } = await create({ loader: new InMemoryI18nLoader({ en: {} }) });
      for (let i = 0; i < 10_000; i++) {
        i18n.translate(`k${i}`);
      }
      i18n.translate('k0');
      expect(warn).toHaveBeenCalledTimes(10_000);

      i18n.translate('k10000');
      i18n.translate('k0');
      expect(warn).toHaveBeenCalledTimes(10_002);
    });
  });

  describe('formatting', () => {
    let i18n: I18nService;

    beforeAll(async () => {
      ({ i18n } = await create({ loader: new InMemoryI18nLoader({ en: {}, de: {} }) }));
    });

    it('keeps formatters apart by options and locale', () => {
      expect(i18n.formatNumber(0.5)).toBe('0.5');
      expect(i18n.formatNumber(0.5, { style: 'percent' })).toBe('50%');
      expect(i18n.formatNumber(0.5, { locale: 'de' })).toBe('0,5');
      expect(i18n.formatNumber(0.5)).toBe('0.5');
    });

    it('formats bigints', () => {
      expect(i18n.formatNumber(12345678901234567890n, { locale: 'de-DE' })).toBe(
        '12.345.678.901.234.567.890',
      );
    });
  });

  describe('locale matching', () => {
    let i18n: I18nService;

    beforeAll(async () => {
      ({ i18n } = await create({ loader: new InMemoryI18nLoader({ en: {}, pl: {} }) }));
    });

    it('trims and lower-cases candidates', () => {
      expect(i18n.matchLocale('  PL ')).toBe('pl');
      expect(i18n.matchLocale('')).toBeUndefined();
    });

    it('cuts candidates longer than any supported locale at a subtag boundary', () => {
      expect(i18n.matchLocale(`pl-PL-${'x'.repeat(10_000)}`)).toBe('pl');
      // "plx" is not a subtag of "pl"
      expect(i18n.matchLocale('plx-PL')).toBeUndefined();
      expect(i18n.matchLocale('plx')).toBeUndefined();
    });
  });

  describe('startup', () => {
    it('adds a regional defaultLocale served by its base language to the supported locales', async () => {
      const { i18n } = await create({
        defaultLocale: 'pl-PL',
        loader: new InMemoryI18nLoader({ pl: { hi: 'Cześć' } }),
      });
      expect(i18n.supportedLocales).toEqual(['pl', 'pl-PL']);
      expect(i18n.matchLocale('pl_pl')).toBe('pl-PL');
      expect(i18n.t('hi')).toBe('Cześć');
      expect(warn).not.toHaveBeenCalled();
    });

    it('says when the loader returned no catalogs at all', async () => {
      await expect(create({ loader: new InMemoryI18nLoader({}) })).rejects.toThrow(
        `I18nModule: there's no catalog for defaultLocale "en". The loader returned no catalogs.`,
      );
    });

    it('names a malformed catalog locale it cannot suggest a spelling for', async () => {
      await expect(create({ loader: new InMemoryI18nLoader({ en: {}, 'e!n': {} }) })).rejects.toThrow(
        'I18nModule: the loader returned a catalog for "e!n", which isn\'t a BCP 47 language tag ' +
          'such as "en" or "pt-BR". Rename it, or set supportedLocales to the locales you serve.',
      );
    });

    it('names a malformed defaultLocale it cannot suggest a spelling for', async () => {
      await expect(
        create({ defaultLocale: 'e!n', loader: new InMemoryI18nLoader({ en: {} }) }),
      ).rejects.toThrow('I18nModule: defaultLocale "e!n" isn\'t a BCP 47 language tag such as "en" or "pt-BR".');
    });

    it('fails when an async loader fails', async () => {
      class FailingLoader extends I18nLoader {
        async load(): Promise<I18nCatalogs> {
          throw new Error('database is down');
        }
      }
      await expect(create({ loader: new FailingLoader() })).rejects.toThrow('database is down');
    });
  });
});
