import { Logger, Module, type INestApplication } from '@nestjs/common';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  AcceptLanguageLocaleResolver,
  I18nModule,
  JsonI18nLoader,
  QueryLocaleResolver,
  type I18nForRootOptions,
} from '../lib/index.js';
import { AppController, localesPath } from './app.js';

const waitOptions = { timeout: 3000, interval: 25 };

function appModule(path: string, options: Partial<I18nForRootOptions> = {}) {
  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new JsonI18nLoader({ path, watch: true }),
        resolvers: [new QueryLocaleResolver('lang'), new AcceptLanguageLocaleResolver()],
        ...options,
      }),
    ],
    controllers: [AppController],
  })
  class HotReloadAppModule {}

  return HotReloadAppModule;
}

describe.each(adapters)('hot reload of JSON catalogs over $name', ({ name }) => {
  let dir: string;
  let app: INestApplication;

  const greet = (query: string, acceptLanguage?: string) => {
    const req = request(app.getHttpServer()).get(`/greet?name=Ada${query}`);
    if (acceptLanguage) {
      req.set('accept-language', acceptLanguage);
    }
    return req;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nest-i18n-http-'));
    await cp(localesPath, dir, { recursive: true });
  });
  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves an edited message to the next request, without a restart', async () => {
    app = await createApp(name, appModule(dir));
    expect((await greet('&lang=pl').expect(200)).body.message).toBe('Cześć, Ada!');

    await writeFile(join(dir, 'pl', 'users.json'), JSON.stringify({ greeting: 'Siema, {name}!' }));

    await vi.waitFor(async () => {
      expect((await greet('&lang=pl').expect(200)).body.message).toBe('Siema, Ada!');
    }, waitOptions);
    expect((await greet('&lang=de').expect(200)).body.message).toBe('Hallo, Ada!');
  });

  it('a new locale directory becomes a locale requests can get, with its Content-Language', async () => {
    app = await createApp(name, appModule(dir));
    const before = await greet('', 'fr-CA, de;q=0.1').expect(200);
    expect(before.body).toEqual({ locale: 'de', message: 'Hallo, Ada!' });

    await mkdir(join(dir, 'fr'));
    await writeFile(join(dir, 'fr', 'users.json'), JSON.stringify({ greeting: 'Salut, {name} !' }));

    await vi.waitFor(async () => {
      const res = await greet('', 'fr-CA, de;q=0.1').expect(200);
      expect(res.body).toEqual({ locale: 'fr', message: 'Salut, Ada !' });
      expect(res.headers['content-language']).toBe('fr');
    }, waitOptions);
  });

  it('keeps serving the last good catalogs while a file is broken, and recovers on the next good save', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      app = await createApp(name, appModule(dir));

      await writeFile(join(dir, 'pl', 'users.json'), '{ "greeting": "half-saved');
      await vi.waitFor(() => expect(error).toHaveBeenCalled(), waitOptions);
      expect(String(error.mock.calls[0][0])).toContain(join('pl', 'users.json'));
      expect((await greet('&lang=pl').expect(200)).body.message).toBe('Cześć, Ada!');

      await writeFile(join(dir, 'pl', 'users.json'), JSON.stringify({ greeting: 'Naprawione, {name}!' }));
      await vi.waitFor(async () => {
        expect((await greet('&lang=pl').expect(200)).body.message).toBe('Naprawione, Ada!');
      }, waitOptions);
    } finally {
      error.mockRestore();
    }
  });

  it('with pinned supportedLocales, a new locale directory is loaded but never served', async () => {
    app = await createApp(name, appModule(dir, { supportedLocales: ['en', 'pl', 'de'] }));

    await mkdir(join(dir, 'fr'));
    await writeFile(join(dir, 'fr', 'users.json'), JSON.stringify({ greeting: 'Salut, {name} !' }));
    await writeFile(join(dir, 'pl', 'users.json'), JSON.stringify({ greeting: 'Hej, {name}!' }));
    await vi.waitFor(async () => {
      expect((await greet('&lang=pl').expect(200)).body.message).toBe('Hej, Ada!');
    }, waitOptions);

    const fr = await greet('&lang=fr').expect(200);
    expect(fr.body).toEqual({ locale: 'en', message: 'Hello, Ada!' });
  });
});
