import { Controller, Get, Injectable, Logger, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  CookieLocaleResolver,
  CurrentLocale,
  HeaderLocaleResolver,
  I18nContext,
  I18nModule,
  InMemoryI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  t,
  type I18nForRootOptions,
} from '../lib/index.js';

@Injectable()
class UnavailableProfileResolver extends LocaleResolver {
  async resolve(): Promise<string> {
    throw new Error('profile service is down');
  }
}

@Controller()
class WhoAmIController {
  constructor(private readonly context: I18nContext) {}

  @Get('whoami')
  whoami(@CurrentLocale() locale: string) {
    return { locale, context: this.context.locale, hi: t('hi') };
  }
}

function appModule(options: Omit<I18nForRootOptions, 'loader'>) {
  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader({ en: { hi: 'Hi' }, pl: { hi: 'Cześć' }, de: { hi: 'Hallo' } }),
        ...options,
      }),
    ],
    controllers: [WhoAmIController],
  })
  class AppModule {}
  return AppModule;
}

describe.each(adapters)('resolvers over $name', ({ name }) => {
  describe('cookie and custom header, after a resolver that fails', () => {
    let app: INestApplication;
    let error: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      app = await createApp(
        name,
        appModule({
          resolvers: [UnavailableProfileResolver, new CookieLocaleResolver('locale'), new HeaderLocaleResolver('X-Locale')],
        }),
      );
    });
    afterAll(async () => {
      await app.close();
      error.mockRestore();
    });

    const get = () => request(app.getHttpServer()).get('/whoami');

    it('reads the locale from the cookie, and logs the failing resolver', async () => {
      const res = await get().set('Cookie', 'session=1; locale=pl-PL').expect(200);
      expect(res.body).toEqual({ locale: 'pl', context: 'pl', hi: 'Cześć' });
      expect(String(error.mock.calls.at(-1)?.[0])).toBe(
        'Locale resolver UnavailableProfileResolver failed: Error: profile service is down',
      );
    });

    it('moves on to the header when the cookie names an unsupported locale', async () => {
      const res = await get().set('Cookie', 'locale=fr').set('X-Locale', 'de').expect(200);
      expect(res.body.hi).toBe('Hallo');
      expect(res.headers['content-language']).toBe('de');
      expect(res.headers['vary']).toBe('Cookie, X-Locale');
    });

    it('uses the default locale when nothing matches', async () => {
      const res = await get().expect(200);
      expect(res.body).toEqual({ locale: 'en', context: 'en', hi: 'Hi' });
    });
  });

  describe('responseHeaders: false', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createApp(name, appModule({ responseHeaders: false, resolvers: [new HeaderLocaleResolver()] }));
    });
    afterAll(() => app.close());

    it('translates without setting Content-Language or Vary', async () => {
      const res = await request(app.getHttpServer()).get('/whoami').set('x-lang', 'pl').expect(200);
      expect(res.body.hi).toBe('Cześć');
      expect(res.headers).not.toHaveProperty('content-language');
      expect(res.headers).not.toHaveProperty('vary');
    });
  });

  describe('resolvers that read no headers', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createApp(name, appModule({ resolvers: [new QueryLocaleResolver('locale')] }));
    });
    afterAll(() => app.close());

    it('set Content-Language but no Vary', async () => {
      const res = await request(app.getHttpServer()).get('/whoami?locale=de').expect(200);
      expect(res.body.hi).toBe('Hallo');
      expect(res.headers['content-language']).toBe('de');
      expect(res.headers).not.toHaveProperty('vary');
    });
  });
});
