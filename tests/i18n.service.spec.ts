import { Injectable, Logger, Module, type ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { lastValueFrom, of } from 'rxjs';
import { I18nInterceptor } from '../lib/interceptors/i18n.interceptor.js';
import { I18nMiddleware } from '../lib/middleware/i18n.middleware.js';
import {
  AcceptLanguageLocaleResolver,
  CookieLocaleResolver,
  HeaderLocaleResolver,
  I18N_MODULE_OPTIONS,
  I18nContext,
  I18nLoader,
  I18nMissingKeyError,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  JsonI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  t,
  type I18nCatalogs,
  type I18nModuleAsyncOptions,
  type I18nModuleOptions,
  type I18nOptionsFactory,
  type LocaleResolverInput,
} from '../lib/index.js';
import { LocaleResolution } from '../lib/services/locale-resolution.service.js';
import { parseAcceptLanguage } from '../lib/resolvers/accept-language-locale.resolver.js';
import { localesPath, type AppTranslations } from './app.js';

async function compile(module: any) {
  return Test.createTestingModule({ imports: [module] }).compile();
}

const hello = new InMemoryI18nLoader({ en: { hi: 'Hi' }, pl: { hi: 'Cześć' } });

describe('I18nService outside a request', () => {
  let i18n: I18nService<AppTranslations>;
  let context: I18nContext;

  beforeAll(async () => {
    const ref = await compile(
      I18nModule.forRoot({
        defaultLocale: 'en',
        fallbacks: { 'de-AT': 'de' },
        loader: new JsonI18nLoader({ path: localesPath }),
      }),
    );
    i18n = ref.get(I18nService);
    context = ref.get(I18nContext);
  });

  it('uses the default locale without a context, or an explicit locale', () => {
    expect(context.locale).toBe('en');
    expect(i18n.t('users.greeting', { args: { name: 'Ada' } })).toBe('Hello, Ada!');
    expect(i18n.t('users.greeting', { locale: 'pl', args: { name: 'Ada' } })).toBe(
      'Cześć, Ada!',
    );
    expect(i18n.t('users.greeting', { locale: 'pl-PL', args: { name: 'Ada' } })).toBe(
      'Cześć, Ada!',
    );
  });

  it('interpolates and leaves unknown placeholders alone', () => {
    expect(i18n.t('users.notFound', { args: { id: 7 } })).toBe('User #7 was not found');
    expect(i18n.t('users.notFound')).toBe('User #{id} was not found');
  });

  it('Polish plural categories', () => {
    const apples = (count: number) => i18n.t('users.apples', { locale: 'pl', args: { count } });
    expect([1, 2, 5, 22, 12, 0].map(apples)).toEqual([
      '1 jabłko', '2 jabłka', '5 jabłek', '22 jabłka', '12 jabłek', '0 jabłek',
    ]);
  });

  it('uses the "other" form when a plural message gets no numeric count', () => {
    expect(i18n.translate('users.apples', { locale: 'pl' })).toBe('{count} jabłka');
  });

  it('falls back from a region to its base language, then to the default locale', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      expect(i18n.t('users.greeting', { locale: 'de-AT', args: { name: 'A' } })).toBe('Hallo, A!');
      expect(i18n.t('users.apples', { locale: 'de-AT', args: { count: 2 } })).toBe('2 apples');
    } finally {
      warn.mockRestore();
    }
  });

  it('returns the key and warns once for keys missing everywhere', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      expect(i18n.translate('users.nope', { locale: 'pl' })).toBe('users.nope');
      expect(i18n.translate('users.nope', { locale: 'de' })).toBe('users.nope');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('users.nope');
    } finally {
      warn.mockRestore();
    }
  });

  it('t() translates inside a context, and returns the key with one warning outside', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      expect(context.run('pl', () => t('users.forbidden'))).toBe('Nie masz dostępu do tego zasobu');
      expect(context.run('pl', () => t('users.notFound', { args: { id: 3 } }))).toBe(
        'Nie znaleziono użytkownika #3',
      );
      expect(t('users.forbidden')).toBe('users.forbidden');
      expect(t('users.forbidden')).toBe('users.forbidden');
      expect(warn.mock.calls.filter(([m]) => String(m).includes('outside a request'))).toHaveLength(
        1,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('I18nContext.run() makes a locale current, matched like a request locale', () => {
    expect(context.run('pl-PL', () => [context.locale, t('users.forbidden')])).toEqual([
      'pl',
      'Nie masz dostępu do tego zasobu',
    ]);
    expect(context.run('de-AT', () => context.locale)).toBe('de-AT');
    // an unsupported locale gets the default, as a request asking for it would
    expect(context.run('fr', () => context.locale)).toBe('en');
    expect(context.locale).toBe('en');
  });

  it('formats numbers and dates for the locale', () => {
    const date = new Date(Date.UTC(2026, 0, 15));
    const opts = { dateStyle: 'long', timeZone: 'UTC' } as const;
    context.run('pl', () => {
      expect(i18n.formatDate(date, opts)).toBe('15 stycznia 2026');
      expect(i18n.formatNumber(0.5, { style: 'percent' })).toBe('50%');
    });
    expect(i18n.formatDate(date, { ...opts, locale: 'de' })).toBe('15. Januar 2026');
    expect(i18n.formatNumber(1234.5, { locale: 'de-AT', style: 'currency', currency: 'EUR' })).toBe(
      '€\u00a01.234,50',
    );
    expect(i18n.formatNumber(1234.5)).toBe('1,234.5');
  });

  it('matchLocale() maps candidates to supported locales', () => {
    expect(i18n.matchLocale('PL_pl')).toBe('pl');
    expect(i18n.matchLocale('de-at')).toBe('de-AT');
    expect(i18n.matchLocale('fr')).toBeUndefined();
    // a value read from a database or a JSON body isn't always a string
    expect(i18n.matchLocale(null as unknown as string)).toBeUndefined();
    expect(i18n.matchLocale({ toString: () => 'pl' } as unknown as string)).toBeUndefined();
  });
});

describe('explicit locales (a customer profile, a job payload)', () => {
  const apples = { one: '{count} apple', other: '{count} apples' };
  let i18n: I18nService;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const ref = await compile(
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader({ en: { hi: 'Hi', apples }, pl: { hi: 'Cześć' } }),
        fallbacks: { 'en-GB': 'en' },
        missingKey: 'throw',
      }),
    );
    i18n = ref.get(I18nService);
  });
  afterEach(() => warn.mockRestore());

  it('are matched like a request locale, and anything unsupported gets the default locale', () => {
    expect(i18n.t('hi', { locale: 'PL-pl' })).toBe('Cześć');
    // not a missing Polish or French message: French isn't a supported locale
    expect(i18n.t('hi', { locale: 'fr' })).toBe('Hi');
    expect(i18n.exists('hi', 'fr')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'en_US', 'x', '', 'français'])(
    'never throw for %j',
    (locale) => {
      expect(i18n.t('hi', { locale })).toBe('Hi');
      expect(i18n.t('apples', { locale, args: { count: 2 } })).toBe('2 apples');
      expect(i18n.exists('hi', locale)).toBe(true);
      expect(i18n.formatNumber(1234.5, { locale })).toBe('1,234.5');
      expect(i18n.formatDate(0, { locale, timeZone: 'UTC' })).toBe('1/1/1970');
    },
  );

  it('never read the prototype of the catalogs', () => {
    expect(() => i18n.translate('constructor.name', { locale: '__proto__' })).toThrow(
      new I18nMissingKeyError('constructor.name', 'en'),
    );
    expect(i18n.exists('constructor.name', '__proto__')).toBe(false);
  });
});

describe('interpolation', () => {
  let i18n: I18nService;

  beforeAll(async () => {
    const ref = await compile(
      I18nModule.forRoot({ loader: new InMemoryI18nLoader({ en: { show: 'Got {value}' } }) }),
    );
    i18n = ref.get(I18nService);
  });

  it('never throws on an argument without a string form', () => {
    // null-prototype objects: node:querystring output, Object.create(null) maps
    expect(i18n.t('show', { args: { value: Object.create(null) } })).toBe('Got [object Object]');
    expect(i18n.t('show', { args: { value: Symbol('s') } })).toBe('Got Symbol(s)');
    expect(i18n.t('show', { args: { value: 10n } })).toBe('Got 10');
  });

  it('only reads own arguments', () => {
    expect(i18n.t('show', { args: JSON.parse('{"__proto__": {"value": "polluted"}}') })).toBe(
      'Got {value}',
    );
  });
});

describe('logs', () => {
  it('quote keys and locales, so a key built from request data cannot forge log lines', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const ref = await compile(I18nModule.forRoot({ loader: hello }));
      ref.get(I18nService).translate('errors.x\nERROR [Nest] forged line', { locale: 'pl' });
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        'Missing translation "errors.x\\nERROR [Nest] forged line" (locale "pl")',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('multi-subtag locales (RFC 4647 lookup)', () => {
  let i18n: I18nService;

  beforeAll(async () => {
    const ref = await compile(
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader({
          en: { hi: 'Hi' },
          zh: { hi: '你好 (zh)', bye: '再见 (zh)' },
          'zh-Hant': { hi: '你好 (Hant)' },
          'sr-Latn': { hi: 'Zdravo' },
        }),
      }),
    );
    i18n = ref.get(I18nService);
  });

  it('match the longest supported prefix of a candidate', () => {
    expect(i18n.matchLocale('zh-Hant-TW')).toBe('zh-Hant');
    expect(i18n.matchLocale('zh_hant_hk')).toBe('zh-Hant');
    expect(i18n.matchLocale('zh-Hans-CN')).toBe('zh');
    expect(i18n.matchLocale('sr-Latn-RS')).toBe('sr-Latn');
    // a trailing singleton (an extension or private-use marker) is dropped too
    expect(i18n.matchLocale('sr-Latn-x-foo')).toBe('sr-Latn');
  });

  it('look messages up through every prefix of the locale', async () => {
    const ref = await compile(
      I18nModule.forRoot({
        supportedLocales: ['en', 'zh', 'zh-Hant', 'zh-Hant-TW'],
        loader: new InMemoryI18nLoader({
          en: { hi: 'Hi' },
          zh: { hi: '你好 (zh)', bye: '再见 (zh)' },
          'zh-Hant': { hi: '你好 (Hant)' },
          'zh-Hant-TW': {},
        }),
      }),
    );
    const service = ref.get(I18nService);
    expect(service.t('hi', { locale: 'zh-Hant-TW' })).toBe('你好 (Hant)');
    expect(service.t('bye', { locale: 'zh-Hant-TW' })).toBe('再见 (zh)');
    expect(i18n.t('hi', { locale: 'zh-Hant' })).toBe('你好 (Hant)');
  });
});

describe('locale tags', () => {
  const fails = (options: Partial<I18nModuleOptions>, catalogs: I18nCatalogs = { en: {} }) =>
    expect(
      compile(I18nModule.forRoot({ loader: new InMemoryI18nLoader(catalogs), ...options })),
    ).rejects;

  it('fail at startup when they are not BCP 47, naming the option and a valid tag', async () => {
    await fails({ defaultLocale: 'en_US' }, { en_US: {} }).toThrow(
      'I18nModule: defaultLocale "en_US" isn\'t a BCP 47 language tag. Use "en-US".',
    );
    await fails({ supportedLocales: ['en', 'fr_FR'] }).toThrow(
      'I18nModule: supportedLocales has "fr_FR", which isn\'t a BCP 47 language tag. Use "fr-FR".',
    );
    await fails({ fallbacks: { de_AT: 'de' } }).toThrow(
      'I18nModule: fallbacks has "de_AT", which isn\'t a BCP 47 language tag. Use "de-AT".',
    );
    await fails({ fallbacks: { 'de-AT': 'de!' } }).toThrow(
      'I18nModule: fallbacks has "de!", which isn\'t a BCP 47 language tag such as "en" or "pt-BR".',
    );
    await fails({}, { en: {}, pt_BR: {} }).toThrow(
      'I18nModule: the loader returned a catalog for "pt_BR", which isn\'t a BCP 47 language tag. ' +
        'Rename it to "pt-BR", or set supportedLocales to the locales you serve.',
    );
  });

  it('ignore catalogs outside pinned supportedLocales', async () => {
    const ref = await compile(
      I18nModule.forRoot({
        supportedLocales: ['en'],
        loader: new InMemoryI18nLoader({ en: { hi: 'Hi' }, _drafts: { hi: 'Draft' } }),
      }),
    );
    expect(ref.get(I18nService).supportedLocales).toEqual(['en']);
  });
});

describe('policies', () => {
  // Values often come from environment variables through ConfigService.
  it('fail at startup when missingKey or logMissingKeys is misspelled', async () => {
    await expect(
      compile(I18nModule.forRoot({ loader: hello, missingKey: 'thorw' as 'throw' })),
    ).rejects.toThrow(
      `I18nModule: missingKey is "thorw"; use 'fallback', 'key', 'empty', 'throw' or a function.`,
    );
    await expect(
      compile(I18nModule.forRoot({ loader: hello, logMissingKeys: 'onec' as 'once' })),
    ).rejects.toThrow(`I18nModule: logMissingKeys is "onec"; use 'once', 'always' or 'never'.`);
  });
});

describe('module configuration', () => {
  it('defaults defaultLocale to "en"', async () => {
    const ref = await compile(I18nModule.forRoot({ loader: hello }));
    expect(ref.get(I18nService).defaultLocale).toBe('en');
    expect(ref.get(I18nService).t('hi')).toBe('Hi');
  });

  it('forRootAsync: values from the factory, loader and resolvers next to it', async () => {
    @Injectable()
    class Settings {
      readonly locale = 'pl';
    }
    @Module({ providers: [Settings], exports: [Settings] })
    class SettingsModule {}

    const ref = await compile(
      I18nModule.forRootAsync({
        imports: [SettingsModule],
        inject: [Settings],
        useFactory: async (settings: Settings) => ({ defaultLocale: settings.locale }),
        loader: hello,
        resolvers: [new HeaderLocaleResolver()],
      }),
    );
    const i18n = ref.get(I18nService);
    expect(i18n.t('hi')).toBe('Cześć');
    expect(i18n.supportedLocales).toEqual(['en', 'pl']);
    const resolution = ref.get(LocaleResolution);
    expect(await resolution.resolve({ headers: { 'x-lang': 'en' }, query: {} })).toBe('en');
    expect(await resolution.resolve({ headers: {}, query: {} })).toBe('pl');
  });

  it('forRootAsync: the factory returns loader and resolver instances built from config', async () => {
    @Injectable()
    class Settings {
      readonly catalogs = { en: { hi: 'Hi' }, de: { hi: 'Hallo' } };
      readonly localeHeader = 'x-locale';
    }
    @Module({ providers: [Settings], exports: [Settings] })
    class SettingsModule {}

    const ref = await compile(
      I18nModule.forRootAsync({
        imports: [SettingsModule],
        inject: [Settings],
        useFactory: (settings: Settings) => ({
          loader: new InMemoryI18nLoader(settings.catalogs),
          resolvers: [new HeaderLocaleResolver(settings.localeHeader)],
        }),
      }),
    );
    expect(ref.get(I18nLoader)).toBeInstanceOf(InMemoryI18nLoader);
    expect(ref.get(I18nService).supportedLocales).toEqual(['en', 'de']);
    const resolution = ref.get(LocaleResolution);
    expect(await resolution.resolve({ headers: { 'x-locale': 'de' }, query: {} })).toBe('de');
    // the factory's resolvers replace the default Accept-Language one
    expect(await resolution.resolve({ headers: { 'accept-language': 'de' }, query: {} })).toBe('en');
    expect(resolution.varyHeaders).toEqual(['x-locale']);
  });

  it('forRootAsync({ useClass }): resolver classes at the top level, the loader from createI18nOptions()', async () => {
    @Injectable()
    class FixedLocaleResolver extends LocaleResolver {
      resolve() {
        return 'pl';
      }
    }
    @Injectable()
    class I18nConfig implements I18nOptionsFactory {
      createI18nOptions(): I18nModuleOptions {
        return { loader: hello, missingKey: 'key' };
      }
    }

    const options: I18nModuleAsyncOptions = { useClass: I18nConfig, resolvers: [FixedLocaleResolver] };
    const ref = await compile(I18nModule.forRootAsync(options));
    expect(await ref.get(LocaleResolution).resolve({ headers: {}, query: {} })).toBe('pl');
    expect(ref.get(I18nService).t('hi', { locale: 'pl' })).toBe('Cześć');
    expect(ref.get(I18N_MODULE_OPTIONS).missingKey).toBe('key');
    // useExisting takes a factory another module provides
    @Module({ providers: [I18nConfig], exports: [I18nConfig] })
    class ConfigModule {}
    const existing = await compile(
      I18nModule.forRootAsync({ imports: [ConfigModule], useExisting: I18nConfig }),
    );
    expect(existing.get(I18N_MODULE_OPTIONS).missingKey).toBe('key');
    // the factory's result is checked like useFactory's
    @Injectable()
    class ReturnsAClass implements I18nOptionsFactory {
      createI18nOptions() {
        return { loader: InMemoryI18nLoader as unknown as I18nLoader };
      }
    }
    await expect(compile(I18nModule.forRootAsync({ useClass: ReturnsAClass }))).rejects.toThrow(
      /returned the class InMemoryI18nLoader in "loader"/,
    );
  });

  it('forRoot: imports let loader and resolver classes inject from other modules', async () => {
    @Injectable()
    class Messages {
      catalogs() {
        return { en: { hi: 'Hi' }, pl: { hi: 'Cześć' } };
      }
    }
    @Injectable()
    class Profiles {
      localeOf(userId: unknown) {
        return userId === '7' ? 'pl' : undefined;
      }
    }
    @Module({ providers: [Messages, Profiles], exports: [Messages, Profiles] })
    class AccountsModule {}

    @Injectable()
    class DbLoader extends I18nLoader {
      constructor(private readonly messages: Messages) {
        super();
      }
      load() {
        return this.messages.catalogs();
      }
    }
    @Injectable()
    class ProfileLocaleResolver extends LocaleResolver {
      constructor(private readonly profiles: Profiles) {
        super();
      }
      resolve({ headers }: LocaleResolverInput) {
        return this.profiles.localeOf(headers['x-user-id']);
      }
    }

    const ref = await compile(
      I18nModule.forRoot({
        imports: [AccountsModule],
        loader: DbLoader,
        resolvers: [ProfileLocaleResolver],
      }),
    );
    const resolution = ref.get(LocaleResolution);
    expect(await resolution.resolve({ headers: { 'x-user-id': '7' }, query: {} })).toBe('pl');
    expect(ref.get(I18nService).t('hi', { locale: 'pl' })).toBe('Cześć');
    // top-level options don't reach the options object
    expect(ref.get(I18N_MODULE_OPTIONS)).toEqual({});
    // without imports, AccountsModule's providers can't be injected
    await expect(compile(I18nModule.forRoot({ loader: DbLoader }))).rejects.toThrow(/Messages/);
  });

  it('instantiates a loader class with DI', async () => {
    @Injectable()
    class DbLoader extends I18nLoader {
      async load() {
        return { en: { db: { title: 'From DB' } } };
      }
    }
    const ref = await compile(I18nModule.forRoot({ defaultLocale: 'en', loader: DbLoader }));
    expect(ref.get(I18nService).t('db.title')).toBe('From DB');
  });

  it('instantiates resolver classes with DI, in order with instances', async () => {
    @Injectable()
    class Profiles {
      localeOf(userId: string | undefined) {
        return userId === '7' ? 'pl' : undefined;
      }
    }
    @Module({ providers: [Profiles], exports: [Profiles] })
    class ProfilesModule {}

    @Injectable()
    class ProfileLocaleResolver extends LocaleResolver {
      constructor(private readonly profiles: Profiles) {
        super();
      }
      resolve({ headers }: LocaleResolverInput) {
        return this.profiles.localeOf(headers['x-user-id'] as string | undefined);
      }
    }

    const ref = await compile(
      I18nModule.forRootAsync({
        imports: [ProfilesModule],
        useFactory: () => ({}),
        loader: hello,
        resolvers: [new QueryLocaleResolver(), ProfileLocaleResolver, AcceptLanguageLocaleResolver],
      }),
    );
    const resolution = ref.get(LocaleResolution);
    const resolve = (headers: Record<string, string>, query = {}) =>
      resolution.resolve({ headers, query });
    expect(await resolve({ 'x-user-id': '7', 'accept-language': 'en' })).toBe('pl');
    expect(await resolve({ 'x-user-id': '7' }, { lang: 'en' })).toBe('en');
    expect(await resolve({ 'x-user-id': '1', 'accept-language': 'pl' })).toBe('pl');
    expect(resolution.varyHeaders).toEqual(['Accept-Language']);
  });

  it("keeps the catalogs when a custom loader's watch() delivers ones that don't fit, without throwing into the loader", async () => {
    let deliver: (catalogs: I18nCatalogs) => void = () => {};
    let stopped = false;
    class PollingLoader extends I18nLoader {
      load() {
        return { en: { hi: 'Hi' }, pl: { hi: 'Cześć' } };
      }
      watch(onChange: (catalogs: I18nCatalogs) => void) {
        deliver = onChange; // e.g. called from a setInterval() that polls a database
        return () => (stopped = true);
      }
    }
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const ref = await compile(I18nModule.forRoot({ loader: new PollingLoader() }));
      await ref.init();
      const i18n = ref.get(I18nService);
      // an exception here would be an unhandled rejection in the loader's timer
      expect(() => deliver({ pl: { hi: 'Hej' } })).not.toThrow();
      expect(String(error.mock.calls[0][0])).toContain(
        `Keeping the previous translations: I18nModule: there's no catalog for defaultLocale "en"`,
      );
      expect(i18n.t('hi', { locale: 'pl' })).toBe('Cześć');
      deliver({ en: { hi: 'Hello' }, pl: { hi: 'Hej' } });
      expect(i18n.t('hi', { locale: 'pl' })).toBe('Hej');
      expect(log).toHaveBeenCalledWith('Reloaded the translations');
      await ref.close();
      expect(stopped).toBe(true);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('lets tests swap the loader with overrideProvider(I18nLoader)', async () => {
    const ref = await Test.createTestingModule({
      imports: [I18nModule.forRoot({ loader: new JsonI18nLoader({ path: localesPath }) })],
    })
      .overrideProvider(I18nLoader)
      .useValue(new InMemoryI18nLoader({ en: { users: { greeting: 'Test {name}' } } }))
      .compile();
    expect(ref.get(I18nService).translate('users.greeting', { args: { name: 'A' } })).toBe(
      'Test A',
    );
    // a loader returned by forRootAsync()'s factory too
    const asyncRef = await Test.createTestingModule({
      imports: [I18nModule.forRootAsync({ useFactory: () => ({ loader: hello }) })],
    })
      .overrideProvider(I18nLoader)
      .useValue(new InMemoryI18nLoader({ en: { hi: 'Test' } }))
      .compile();
    expect(asyncRef.get(I18nService).t('hi')).toBe('Test');
  });

  it('supportedLocales restricts resolution', async () => {
    const ref = await compile(
      I18nModule.forRoot({
        defaultLocale: 'en',
        supportedLocales: ['en', 'pl'],
        loader: new JsonI18nLoader({ path: localesPath }),
      }),
    );
    const resolution = ref.get(LocaleResolution);
    expect(
      await resolution.resolve({ headers: { 'accept-language': 'de, pl;q=0.5' }, query: {} }),
    ).toBe('pl');
  });

  it('warns at startup about supported locales without a catalog', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      await compile(
        I18nModule.forRoot({
          supportedLocales: ['en', 'en-GB', 'fr'],
          loader: new InMemoryI18nLoader({ en: {} }),
        }),
      );
      // en-GB is served by its base language; fr has nothing
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        'supportedLocales without a catalog: "fr". Their messages follow the missingKey policy.',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('isGlobal: false keeps I18nService to importing modules', async () => {
    @Injectable()
    class Consumer {
      constructor(readonly i18n: I18nService) {}
    }
    @Module({ providers: [Consumer] })
    class FeatureModule {}

    await expect(
      Test.createTestingModule({
        imports: [I18nModule.forRoot({ loader: hello, isGlobal: false }), FeatureModule],
      }).compile(),
    ).rejects.toThrow(/I18nService/);
  });

  it('requires a loader: forRoot() when it is called, forRootAsync() at startup', async () => {
    expect(() => I18nModule.forRoot({} as any)).toThrow(/"loader" option is required/);
    // the factory could have returned one
    const definition = I18nModule.forRootAsync({ useFactory: () => ({ defaultLocale: 'en' }) });
    await expect(compile(definition)).rejects.toThrow(
      'I18nModule: the "loader" option is required, for example ' +
        "loader: new JsonI18nLoader({ path: join(import.meta.dirname, 'i18n') }). " +
        'In forRootAsync(), pass it next to useFactory or return it from the factory.',
    );
  });

  it('fails at startup when the factory returns no options object', async () => {
    for (const result of [undefined, null, 'en']) {
      await expect(
        compile(
          I18nModule.forRootAsync({
            useFactory: () => result as unknown as I18nModuleOptions,
            loader: hello,
          }),
        ),
      ).rejects.toThrow(
        `I18nModule: forRootAsync()'s factory returned ${JSON.stringify(result)}; return the options object, such as { defaultLocale: 'en' }.`,
      );
    }
  });

  it('fails at startup when the factory returns isGlobal or imports', async () => {
    for (const result of [{ isGlobal: false }, { imports: [] }]) {
      const key = Object.keys(result)[0];
      await expect(
        compile(
          I18nModule.forRootAsync({
            useFactory: () => ({ ...result, loader: hello }) as I18nModuleOptions,
          }),
        ),
      ).rejects.toThrow(
        `I18nModule: pass "${key}" to forRootAsync() next to useFactory, not in the options it returns.`,
      );
    }
  });

  it('fails at startup when the factory returns a class, which goes at the top level', async () => {
    @Injectable()
    class DbLoader extends I18nLoader {
      load() {
        return { en: {} };
      }
    }
    await expect(
      compile(I18nModule.forRootAsync({ useFactory: () => ({ loader: DbLoader as any }) })),
    ).rejects.toThrow(
      `I18nModule: forRootAsync()'s factory returned the class DbLoader in "loader". ` +
        'Classes go at the top level of forRootAsync(), next to useFactory, where Nest ' +
        'instantiates them. The factory can return instances only.',
    );
    await expect(
      compile(
        I18nModule.forRootAsync({
          useFactory: () => ({
            resolvers: [new QueryLocaleResolver(), HeaderLocaleResolver as any],
          }),
          loader: hello,
        }),
      ),
    ).rejects.toThrow(
      /returned the class HeaderLocaleResolver in "resolvers"\. Classes go at the top level/,
    );
  });

  it('fails at startup when an option is set both at the top level and by the factory', async () => {
    await expect(
      compile(I18nModule.forRootAsync({ useFactory: () => ({ loader: hello }), loader: hello })),
    ).rejects.toThrow(
      'I18nModule: "loader" is set both at the top level of forRootAsync() and in the ' +
        'options its factory returns. Set it in one place.',
    );
    await expect(
      compile(
        I18nModule.forRootAsync({
          useFactory: () => ({ resolvers: [new QueryLocaleResolver()] }),
          loader: hello,
          resolvers: [HeaderLocaleResolver],
        }),
      ),
    ).rejects.toThrow(/"resolvers" is set both at the top level of forRootAsync\(\)/);
  });

  it('fails at startup when defaultLocale has no catalog', async () => {
    await expect(
      compile(I18nModule.forRoot({ loader: new InMemoryI18nLoader({ pl: {}, de: {} }) })),
    ).rejects.toThrow(
      `I18nModule: there's no catalog for defaultLocale "en". The loader returned "pl", "de"; set defaultLocale to one of them.`,
    );
    // a region default is served by its base language's catalog
    const ref = await compile(
      I18nModule.forRoot({ defaultLocale: 'pl-PL', loader: new InMemoryI18nLoader({ pl: {} }) }),
    );
    expect(ref.get(I18nService).defaultLocale).toBe('pl-PL');
  });
});

describe('I18nInterceptor (entry points the middleware does not wrap)', () => {
  const run = async (resolvers: LocaleResolver[], ctx: object) => {
    const ref = await compile(I18nModule.forRoot({ loader: hello, resolvers }));
    const i18n = ref.get(I18nService);
    const interceptor = new I18nInterceptor(ref.get(LocaleResolution), i18n);
    return lastValueFrom(
      interceptor.intercept(ctx as ExecutionContext, { handle: () => of(i18n.t('hi')) }),
    );
  };

  it('lets rpc resolvers read the execution context', async () => {
    const result = await run(
      [
        { resolve: ({ executionContext }: LocaleResolverInput) => executionContext?.switchToRpc().getData().lang },
        new HeaderLocaleResolver(),
      ],
      {
        getType: () => 'rpc',
        switchToRpc: () => ({ getData: () => ({ lang: 'pl' }), getContext: () => ({}) }),
      },
    );
    expect(result).toBe('Cześć');
  });

  it('reads the HTTP request from the GraphQL context (drivers mounted before the middleware)', async () => {
    const result = await run([new AcceptLanguageLocaleResolver()], {
      getType: () => 'graphql',
      getArgByIndex: (index: number) =>
        index === 2 ? { req: { headers: { 'accept-language': 'pl-PL' } } } : undefined,
    });
    expect(result).toBe('Cześć');
  });

  it('reads the upgrade request of a graphql-ws subscription, headers and query', async () => {
    const subscription = (context: object) =>
      run([new QueryLocaleResolver(), new AcceptLanguageLocaleResolver()], {
        getType: () => 'graphql',
        getArgByIndex: (index: number) => (index === 2 ? context : undefined),
      });
    const upgrade = { headers: { 'accept-language': 'de' }, url: '/graphql?lang=pl' };
    // Nest's default context puts graphql-ws's context at `req`
    expect(await subscription({ req: { extra: { request: upgrade } } })).toBe('Cześć');
    // a context function that returns graphql-ws's context as is
    expect(await subscription({ extra: { request: { headers: { 'accept-language': 'pl' } } } })).toBe(
      'Cześć',
    );
  });

  it('reads a WebSocket handshake: socket.io, or the upgrade request on client.request', async () => {
    const ws = (client: object) =>
      run([new QueryLocaleResolver(), new AcceptLanguageLocaleResolver()], {
        getType: () => 'ws',
        switchToWs: () => ({ getClient: () => client, getData: () => ({}) }),
      });
    expect(await ws({ handshake: { headers: { 'accept-language': 'pl' }, query: {} } })).toBe('Cześć');
    expect(await ws({ handshake: { headers: {}, query: { lang: 'pl' } } })).toBe('Cześć');
    // the `ws` library keeps no request; WsAuthenticator (or the gateway) stores it on the client
    expect(await ws({ request: { headers: {}, url: '/ws?lang=pl' } })).toBe('Cześć');
    expect(await ws({})).toBe('Hi');
  });
});

describe('built-in resolvers', () => {
  it('parseAcceptLanguage orders by q-value, keeps header order on ties, drops q=0 and *', () => {
    expect(parseAcceptLanguage('de;q=0.3, fr, pl-PL;q=0.9, *;q=0.1, it;q=0, en;q=0.9')).toEqual([
      'fr', 'pl-PL', 'en', 'de',
    ]);
  });

  it('parseAcceptLanguage reads the weight case-insensitively (RFC 9110)', () => {
    expect(parseAcceptLanguage('pl;Q=0.5, de;q=0.6, fr; q=0.7')).toEqual(['fr', 'de', 'pl']);
    // malformed weights count as 0, never as a preference
    expect(parseAcceptLanguage('pl;q=abc, de;q=, en')).toEqual(['en']);
  });

  it('CookieLocaleResolver reads one cookie', () => {
    const resolve = (cookie?: string, name?: string) =>
      new CookieLocaleResolver(name).resolve({ headers: { cookie }, query: {} });
    expect(resolve('session=abc; lang=pl')).toBe('pl');
    expect(resolve('locale="de-AT"', 'locale')).toBe('de-AT');
    expect(resolve('xlang=pl')).toBeUndefined();
    expect(resolve('lang=')).toBeUndefined();
    expect(resolve()).toBeUndefined();
    expect(new CookieLocaleResolver().varyHeaders).toEqual(['Cookie']);
  });
});

describe('I18nMiddleware response headers', () => {
  const run = async (
    options: I18nModuleOptions & { resolvers?: LocaleResolver[] },
    existingVary?: string,
  ) => {
    const ref = await compile(
      I18nModule.forRoot({ loader: new InMemoryI18nLoader({ en: {}, pl: {} }), ...options }),
    );
    const middleware = new I18nMiddleware(
      ref.get(LocaleResolution),
      ref.get(I18nService),
      ref.get(I18N_MODULE_OPTIONS),
    );
    const headers: Record<string, string> = existingVary ? { vary: existingVary } : {};
    const res = {
      getHeader: (name: string) => headers[name.toLowerCase()],
      setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value),
    };
    await middleware.use({ headers: { 'accept-language': 'pl' }, url: '/' }, res, () => {});
    return headers;
  };

  it('merges into an existing Vary header without duplicates', async () => {
    expect(await run({}, 'Origin, accept-language')).toEqual({
      vary: 'Origin, accept-language',
      'content-language': 'pl',
    });
    expect(
      await run({ resolvers: [new QueryLocaleResolver(), new AcceptLanguageLocaleResolver()] }),
    ).toEqual({
      vary: 'Accept-Language',
      'content-language': 'pl',
    });
  });

  it('can be turned off', async () => {
    expect(await run({ responseHeaders: false })).toEqual({});
  });

  it('merges into the headers writeHead() sends, in every form', async () => {
    const ref = await compile(I18nModule.forRoot({ loader: new InMemoryI18nLoader({ en: {}, pl: {} }) }));
    const middleware = new I18nMiddleware(
      ref.get(LocaleResolution),
      ref.get(I18nService),
      ref.get(I18N_MODULE_OPTIONS),
    );
    const written = async (...args: unknown[]) => {
      const headers: Record<string, string> = {};
      let sent: unknown[] = [];
      const res = {
        getHeader: (name: string) => headers[name.toLowerCase()],
        setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value),
        writeHead: (...writeArgs: unknown[]) => (sent = writeArgs),
      };
      await middleware.use({ headers: { 'accept-language': 'pl' }, url: '/' }, res, () => {});
      res.setHeader('Vary', 'X-Tenant'); // a handler's @Header('Vary', ...)
      res.writeHead(...args);
      return { sent, vary: headers.vary };
    };
    // Fastify: the reply headers, @fastify/cors's Vary among them
    expect((await written(200, { Vary: 'Origin', 'content-type': 'x' })).sent).toEqual([
      200,
      { Vary: 'Origin, Accept-Language', 'content-type': 'x' },
    ]);
    expect((await written(200, 'OK', ['vary', 'Origin', 'x-a', 'b'])).sent).toEqual([
      200,
      'OK',
      ['vary', 'Origin, Accept-Language', 'x-a', 'b'],
    ]);
    // Express: no headers argument, so the response's own Vary is merged
    expect(await written(200)).toEqual({ sent: [200], vary: 'X-Tenant, Accept-Language' });
    expect((await written(200, { vary: '*' })).sent).toEqual([200, { vary: '*' }]);
  });
});

describe('second review pass', () => {
  it('a repeated query parameter keeps its first value on both entry paths', async () => {
    const ref = await compile(
      I18nModule.forRoot({ loader: hello, resolvers: [new QueryLocaleResolver('lang')] }),
    );
    const i18n = ref.get(I18nService);
    // the middleware parses the raw URL itself
    const headers: Record<string, string> = {};
    const middleware = new I18nMiddleware(ref.get(LocaleResolution), i18n, ref.get(I18N_MODULE_OPTIONS));
    await middleware.use(
      { headers: {}, url: '/?lang=pl&lang=de&__proto__=x' },
      { setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value) },
      () => {},
    );
    expect(headers['content-language']).toBe('pl');
    // the interceptor reads the query the adapter parsed (arrays for repeats)
    const interceptor = new I18nInterceptor(ref.get(LocaleResolution), i18n);
    const result = await lastValueFrom(
      interceptor.intercept(
        {
          getType: () => 'http',
          switchToHttp: () => ({ getRequest: () => ({ headers: {}, query: { lang: ['pl', 'de'] } }) }),
        } as unknown as ExecutionContext,
        { handle: () => of(i18n.t('hi')) },
      ),
    );
    expect(result).toBe('Cześć');
  });

  it('I18nContext.run() takes a missing locale (a profile that never set one)', async () => {
    const ref = await compile(I18nModule.forRoot({ loader: hello }));
    const context = ref.get(I18nContext);
    const i18n = ref.get(I18nService);
    expect(context.run(undefined, () => context.locale)).toBe('en');
    expect(context.run(null, () => i18n.t('hi'))).toBe('Hi');
    expect(context.run('pl-PL', () => i18n.t('hi'))).toBe('Cześć');
  });

  it('supportedLocales lists the fallbacks keys, which requests can get', async () => {
    const ref = await compile(
      I18nModule.forRoot({
        loader: hello,
        supportedLocales: ['en', 'pl'],
        fallbacks: { 'pl-PL': 'pl', 'de-AT': 'en' },
      }),
    );
    const i18n = ref.get(I18nService);
    expect(i18n.supportedLocales).toEqual(['en', 'pl', 'pl-PL', 'de-AT']);
    expect(i18n.matchLocale('de-at')).toBe('de-AT');
    expect(i18n.t('hi', { locale: 'de-AT' })).toBe('Hi');
  });

  it('forRootAsync() lists each top-level import once', () => {
    @Module({})
    class ConfigModule {}
    const definition = I18nModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: () => ({ loader: hello }),
    });
    expect(definition.imports).toEqual([ConfigModule]);
    expect(I18nModule.forRoot({ imports: [ConfigModule], loader: hello }).imports).toEqual([ConfigModule]);
  });
});
