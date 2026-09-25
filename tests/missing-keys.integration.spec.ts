import {
  Catch,
  Controller,
  Get,
  Logger,
  Module,
  Param,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  HeaderLocaleResolver,
  I18nLoader,
  I18nMissingKeyError,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  type I18nForRootOptions,
} from '../lib/index.js';
import { AppModule } from './app.js';

const catalogs = {
  en: { hello: 'Hello', onlyEn: 'English only' },
  de: { hello: 'Hallo' },
};

@Controller()
class MessagesController {
  constructor(private readonly i18nService: I18nService) {}

  @Get('t/:key')
  translate(@Param('key') key: string) {
    return { message: this.i18nService.translate(key) };
  }
}

/** What a CI-oriented app does with `missingKey: 'throw'`: report the key and locale. */
@Catch(I18nMissingKeyError)
class MissingKeyFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(error: I18nMissingKeyError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    this.httpAdapterHost.httpAdapter.reply(
      response,
      { error: error.name, key: error.key, locale: error.locale, message: error.message },
      500,
    );
  }
}

function appModule(options: Partial<I18nForRootOptions>) {
  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader(catalogs),
        fallbacks: { 'de-AT': 'de' },
        resolvers: [new HeaderLocaleResolver('x-lang')],
        ...options,
      }),
    ],
    controllers: [MessagesController],
  })
  class MissingKeysAppModule {}

  return MissingKeysAppModule;
}

describe.each(adapters)('missing keys over $name', ({ name }) => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  async function boot(options: Partial<I18nForRootOptions>) {
    const app = await createApp(name, appModule(options), {
      setup: (a) => {
        a.useGlobalFilters(new MissingKeyFilter(a.get(HttpAdapterHost)));
      },
    });
    const get = (key: string, locale?: string) => {
      const req = request(app.getHttpServer()).get(`/t/${key}`);
      if (locale) {
        req.set('x-lang', locale);
      }
      return req;
    };

    return { app, get };
  }

  const warnings = () => warn.mock.calls.map((call: unknown[]) => call[0]);

  describe("'fallback' (the default)", () => {
    let app: INestApplication;
    let get: Awaited<ReturnType<typeof boot>>['get'];

    beforeAll(async () => {
      ({ app, get } = await boot({}));
    });
    afterAll(() => app.close());

    it('serves the default locale, keeps Content-Language, and warns once per key and locale', async () => {
      for (let i = 0; i < 2; i++) {
        const res = await get('onlyEn', 'de').expect(200);
        expect(res.body.message).toBe('English only');
        expect(res.headers['content-language']).toBe('de');
      }

      expect(warnings()).toEqual(['Missing translation "onlyEn" for locale "de"; using "en"']);
    });

    it('follows the region to its base language without a warning', async () => {
      const res = await get('hello', 'de-AT').expect(200);

      expect(res.body.message).toBe('Hallo');
      expect(res.headers['content-language']).toBe('de-AT');
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns the key for a key missing everywhere, and names it in the log', async () => {
      const res = await get('nowhere', 'de').expect(200);

      expect(res.body.message).toBe('nowhere');
      expect(warnings()).toEqual(['Missing translation "nowhere" (locale "de")']);
    });
  });

  it("'key' returns the key instead of the default locale, but still follows the region", async () => {
    const { app, get } = await boot({ missingKey: 'key' });

    expect((await get('onlyEn', 'de').expect(200)).body.message).toBe('onlyEn');
    expect((await get('hello', 'de-AT').expect(200)).body.message).toBe('Hallo');
    expect((await get('onlyEn').expect(200)).body.message).toBe('English only');
    await app.close();
  });

  it("'empty' returns an empty string", async () => {
    const { app, get } = await boot({ missingKey: 'empty' });

    expect((await get('onlyEn', 'de').expect(200)).body.message).toBe('');
    await app.close();
  });

  it("'throw' fails the request with I18nMissingKeyError, which a filter can report", async () => {
    const { app, get } = await boot({ missingKey: 'throw' });

    const res = await get('onlyEn', 'de-AT').expect(500);
    expect(res.body).toEqual({
      error: 'I18nMissingKeyError',
      key: 'onlyEn',
      locale: 'de-AT',
      message: 'Missing translation "onlyEn" for locale "de-AT"',
    });
    expect((await get('hello', 'de-AT').expect(200)).body.message).toBe('Hallo');
    await app.close();
  });

  it('a function gets the key and the matched locale', async () => {
    const { app, get } = await boot({ missingKey: (key, locale) => `[${locale}] ${key}` });

    expect((await get('onlyEn', 'de-DE').expect(200)).body.message).toBe('[de] onlyEn');
    await app.close();
  });

  it("logMissingKeys: 'always' warns on every request, 'never' on none", async () => {
    const always = await boot({ missingKey: 'key', logMissingKeys: 'always' });
    await always.get('nowhere', 'de').expect(200);
    await always.get('nowhere', 'de').expect(200);
    await always.app.close();
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockClear();
    const never = await boot({ logMissingKeys: 'never' });
    await never.get('onlyEn', 'de').expect(200);
    await never.get('nowhere', 'de').expect(200);
    await never.app.close();
    expect(warn).not.toHaveBeenCalled();
  });

  it('overrideProvider(I18nLoader) swaps the catalogs of a real app, e.g. to drop a key', async () => {
    const app = await createApp(name, AppModule, {
      override: (builder) =>
        builder.overrideProvider(I18nLoader).useValue(
          new InMemoryI18nLoader({
            en: { users: { greeting: 'Hi, {name}' } },
            pl: { users: {} },
          }),
        ),
    });

    const res = await request(app.getHttpServer()).get('/greet?name=Ada&lang=pl').expect(200);
    expect(res.body).toEqual({ locale: 'pl', message: 'Hi, Ada' });
    expect(warnings()).toContain('Missing translation "users.greeting" for locale "pl"; using "en"');

    const unknown = await request(app.getHttpServer()).get('/greet?name=Ada&lang=de').expect(200);
    expect(unknown.body.locale).toBe('en');
    await app.close();
  });
});
