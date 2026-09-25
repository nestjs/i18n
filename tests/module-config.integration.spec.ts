import { Controller, Get, Inject, Injectable, Module, Query, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  AcceptLanguageLocaleResolver,
  CurrentLocale,
  HeaderLocaleResolver,
  I18N_MODULE_OPTIONS,
  I18nLoader,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  JsonI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  type I18nCatalogs,
  type I18nModuleAsyncOptions,
  type I18nModuleOptions,
  type I18nOptionsFactory,
  type LocaleResolverInput,
} from '../lib/index.js';
import { localesPath } from './app.js';

/** Stands in for `@nestjs/config`: values an async factory reads. */
@Injectable()
class AppConfig {
  readonly values: Record<string, string> = {
    DEFAULT_LOCALE: 'pl',
    LOCALE_HEADER: 'x-app-locale',
    MISSING_KEY: 'key',
  };

  get(name: string): string {
    return this.values[name];
  }
}

@Module({ providers: [AppConfig], exports: [AppConfig] })
class ConfigModule {}

@Injectable()
class UsersService {
  private readonly sessions = new Map([
    ['s-zofia', { name: 'Zofia', locale: 'pl-PL' }],
    ['s-hans', { name: 'Hans', locale: 'de-AT' }],
    ['s-nobody', { name: 'Nobody', locale: undefined }],
  ]);

  fromSessionCookie(cookie: string | undefined) {
    const id = /(?:^|;\s*)session=([^;]+)/.exec(cookie ?? '')?.[1];
    return id ? this.sessions.get(id) : undefined;
  }
}

@Module({ providers: [UsersService], exports: [UsersService] })
class UsersModule {}

/** The README's resolver: a user's saved locale, read from the session before guards run. */
@Injectable()
class ProfileLocaleResolver extends LocaleResolver {
  override readonly varyHeaders = ['Cookie'];

  constructor(private readonly usersService: UsersService) {
    super();
  }

  async resolve({ headers }: LocaleResolverInput) {
    return this.usersService.fromSessionCookie(headers.cookie as string | undefined)?.locale;
  }
}

@Injectable()
class MessagesRepository {
  async catalogsByLocale(): Promise<I18nCatalogs> {
    return {
      en: { users: { greeting: 'Hello from the database, {name}!' } },
      pl: { users: { greeting: 'Cześć z bazy danych, {name}!' } },
      de: { users: { greeting: 'Hallo aus der Datenbank, {name}!' } },
    };
  }
}

@Module({ providers: [MessagesRepository], exports: [MessagesRepository] })
class MessagesModule {}

/** The README's loader class: catalogs from a repository Nest injects. */
@Injectable()
class DatabaseI18nLoader extends I18nLoader {
  constructor(private readonly messagesRepository: MessagesRepository) {
    super();
  }

  async load(): Promise<I18nCatalogs> {
    return this.messagesRepository.catalogsByLocale();
  }
}

@Controller()
class ConfigController {
  constructor(
    private readonly i18nService: I18nService,
    @Inject(I18N_MODULE_OPTIONS) private readonly options: I18nModuleOptions,
  ) {}

  @Get('greet')
  greet(@Query('name') name: string, @CurrentLocale() locale: string) {
    return { locale, message: this.i18nService.translate('users.greeting', { args: { name } }) };
  }

  @Get('missing')
  missing() {
    return { message: this.i18nService.translate('users.nope') };
  }

  @Get('options')
  readOptions() {
    return { defaultLocale: this.options.defaultLocale, missingKey: this.options.missingKey };
  }

  /** A language picker, and the check a profile form runs before saving a locale. */
  @Get('locales')
  locales(@Query('candidate') candidate?: string) {
    return {
      defaultLocale: this.i18nService.defaultLocale,
      supportedLocales: [...this.i18nService.supportedLocales].sort(),
      match: candidate === undefined ? undefined : (this.i18nService.matchLocale(candidate) ?? null),
    };
  }
}

describe.each(adapters)('module configuration over $name', ({ name }) => {
  describe('forRootAsync({ useFactory }): loader and resolver instances built from configuration', () => {
    let app: INestApplication;

    @Module({
      imports: [
        I18nModule.forRootAsync({
          imports: [ConfigModule],
          inject: [AppConfig],
          useFactory: (config: AppConfig): I18nModuleOptions => ({
            loader: new JsonI18nLoader({ path: localesPath }),
            resolvers: [new HeaderLocaleResolver(config.get('LOCALE_HEADER'))],
            defaultLocale: config.get('DEFAULT_LOCALE'),
            missingKey: config.get('MISSING_KEY') as 'key',
          }),
        }),
      ],
      controllers: [ConfigController],
    })
    class FactoryAppModule {}

    beforeAll(async () => {
      app = await createApp(name, FactoryAppModule);
    });
    afterAll(() => app.close());

    it('uses the header and default locale the factory read', async () => {
      const header = await request(app.getHttpServer()).get('/greet?name=Ada').set('x-app-locale', 'de').expect(200);
      expect(header.body).toEqual({ locale: 'de', message: 'Hallo, Ada!' });
      expect(header.headers['vary']).toBe('x-app-locale');

      const fallback = await request(app.getHttpServer()).get('/greet?name=Ada').set('accept-language', 'de').expect(200);
      expect(fallback.body).toEqual({ locale: 'pl', message: 'Cześć, Ada!' });
      expect(fallback.headers['content-language']).toBe('pl');
    });

    it("applies the factory's missing-key policy, and injects its result as I18N_MODULE_OPTIONS", async () => {
      expect((await request(app.getHttpServer()).get('/missing').expect(200)).body.message).toBe('users.nope');
      expect((await request(app.getHttpServer()).get('/options').expect(200)).body).toEqual({
        defaultLocale: 'pl',
        missingKey: 'key',
      });
    });
  });

  describe('classes at the top level, injecting from the modules in imports', () => {
    let app: INestApplication;

    @Module({
      imports: [
        I18nModule.forRootAsync({
          imports: [ConfigModule, UsersModule, MessagesModule],
          inject: [AppConfig],
          useFactory: (config: AppConfig): I18nModuleOptions => ({ defaultLocale: config.get('DEFAULT_LOCALE') }),
          loader: DatabaseI18nLoader,
          resolvers: [ProfileLocaleResolver, new AcceptLanguageLocaleResolver()],
        }),
      ],
      controllers: [ConfigController],
    })
    class ClassesAppModule {}

    beforeAll(async () => {
      app = await createApp(name, ClassesAppModule);
    });
    afterAll(() => app.close());

    const greet = () => request(app.getHttpServer()).get('/greet?name=Ada');

    it("reads the signed-in user's saved locale before Accept-Language", async () => {
      const zofia = await greet().set('Cookie', 'session=s-zofia').set('accept-language', 'de').expect(200);
      expect(zofia.body).toEqual({ locale: 'pl', message: 'Cześć z bazy danych, Ada!' });
      expect(zofia.headers['vary']).toBe('Cookie, Accept-Language');

      const hans = await greet().set('Cookie', 'theme=dark; session=s-hans').expect(200);
      expect(hans.body).toEqual({ locale: 'de', message: 'Hallo aus der Datenbank, Ada!' });
    });

    it('moves on to Accept-Language for a user without a saved locale, or an anonymous request', async () => {
      const nobody = await greet().set('Cookie', 'session=s-nobody').set('accept-language', 'de-CH').expect(200);
      expect(nobody.body.locale).toBe('de');

      const anonymous = await greet().expect(200);
      expect(anonymous.body).toEqual({ locale: 'pl', message: 'Cześć z bazy danych, Ada!' });
    });
  });

  describe('forRootAsync({ useClass }) and forRootAsync({ useExisting })', () => {
    @Injectable()
    class I18nConfigService implements I18nOptionsFactory {
      constructor(private readonly config: AppConfig) {}

      createI18nOptions(): I18nModuleOptions {
        return {
          loader: new JsonI18nLoader({ path: localesPath }),
          resolvers: [new QueryLocaleResolver('locale')],
          defaultLocale: this.config.get('DEFAULT_LOCALE'),
        };
      }
    }

    @Module({ imports: [ConfigModule], providers: [I18nConfigService], exports: [I18nConfigService] })
    class I18nConfigModule {}

    it.each<[string, I18nModuleAsyncOptions]>([
      ['useClass', { imports: [ConfigModule], useClass: I18nConfigService }],
      ['useExisting', { imports: [I18nConfigModule], useExisting: I18nConfigService }],
    ])('%s: the options come from createI18nOptions()', async (_kind, asyncOptions) => {
      @Module({ imports: [I18nModule.forRootAsync(asyncOptions)], controllers: [ConfigController] })
      class OptionsFactoryAppModule {}

      const app = await createApp(name, OptionsFactoryAppModule);

      const de = await request(app.getHttpServer()).get('/greet?name=Ada&locale=de').expect(200);
      expect(de.body).toEqual({ locale: 'de', message: 'Hallo, Ada!' });
      const none = await request(app.getHttpServer()).get('/greet?name=Ada').expect(200);
      expect(none.body.locale).toBe('pl');
      await app.close();
    });
  });

  describe('without resolvers: Accept-Language', () => {
    let app: INestApplication;

    @Module({
      imports: [I18nModule.forRoot({ loader: new JsonI18nLoader({ path: localesPath }) })],
      controllers: [ConfigController],
    })
    class DefaultsAppModule {}

    beforeAll(async () => {
      app = await createApp(name, DefaultsAppModule);
    });
    afterAll(() => app.close());

    it('reads Accept-Language, ignores the query and other headers, and defaults to en', async () => {
      const res = await request(app.getHttpServer())
        .get('/greet?name=Ada&lang=de')
        .set('x-lang', 'de')
        .set('accept-language', 'fr, pl;q=0.8')
        .expect(200);
      expect(res.body).toEqual({ locale: 'pl', message: 'Cześć, Ada!' });
      expect(res.headers['vary']).toBe('Accept-Language');

      const none = await request(app.getHttpServer()).get('/greet?name=Ada').expect(200);
      expect(none.body.locale).toBe('en');
      expect(none.headers['content-language']).toBe('en');
    });
  });

  describe('pinned supportedLocales, fallbacks and multi-subtag locales', () => {
    let app: INestApplication;

    @Module({
      imports: [
        I18nModule.forRoot({
          loader: new InMemoryI18nLoader({
            en: { users: { greeting: 'Hello, {name}!' } },
            pl: { users: { greeting: 'Cześć, {name}!' } },
            fr: { users: { greeting: 'Bonjour, {name} !' } },
            zh: { users: { greeting: '你好，{name}！' } },
            'zh-Hant': { users: { greeting: '妳好，{name}！' } },
          }),
          supportedLocales: ['en', 'pl', 'zh', 'zh-Hant'],
          fallbacks: { 'pl-SI': 'pl' },
          resolvers: [new AcceptLanguageLocaleResolver()],
        }),
      ],
      controllers: [ConfigController],
    })
    class PinnedAppModule {}

    beforeAll(async () => {
      app = await createApp(name, PinnedAppModule);
    });
    afterAll(() => app.close());

    const greet = (acceptLanguage: string) =>
      request(app.getHttpServer()).get('/greet?name=Ada').set('accept-language', acceptLanguage).expect(200);

    it('never serves a catalog outside the pinned locales', async () => {
      const res = await greet('fr-FR, fr;q=0.9');
      expect(res.body).toEqual({ locale: 'en', message: 'Hello, Ada!' });
      expect(res.headers['content-language']).toBe('en');
    });

    it('matches the longest supported prefix (zh-Hant-TW → zh-Hant, zh-CN → zh)', async () => {
      const hant = await greet('zh-Hant-TW');
      expect(hant.body).toEqual({ locale: 'zh-Hant', message: '妳好，Ada！' });
      expect(hant.headers['content-language']).toBe('zh-Hant');

      expect((await greet('zh-CN')).body.locale).toBe('zh');
    });

    it('serves a fallbacks key as its own locale, with the messages of its target', async () => {
      const res = await greet('pl-SI');
      expect(res.body).toEqual({ locale: 'pl-SI', message: 'Cześć, Ada!' });
      expect(res.headers['content-language']).toBe('pl-SI');
    });

    it('lists every locale a request can get for a language picker, and matches a profile candidate', async () => {
      const res = await request(app.getHttpServer()).get('/locales?candidate=ZH_hant_hk').expect(200);
      expect(res.body).toEqual({
        defaultLocale: 'en',
        supportedLocales: ['en', 'pl', 'pl-SI', 'zh', 'zh-Hant'],
        match: 'zh-Hant',
      });

      const unsupported = await request(app.getHttpServer()).get('/locales?candidate=fr').expect(200);
      expect(unsupported.body.match).toBeNull();
    });
  });
});
