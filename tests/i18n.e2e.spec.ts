import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import { I18nValidationPipe } from '../lib/index.js';
import { AppModule } from './app.js';

describe.each(adapters)('i18n over $name', ({ name }) => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp(name, AppModule, {
      setup: (a) => {
        a.useGlobalPipes(new I18nValidationPipe());
      },
    });
  });
  afterAll(() => app.close());

  describe('locale resolution', () => {
    it('falls back to the default locale', async () => {
      const res = await http().get('/greet?name=Ada').expect(200);
      expect(res.body).toEqual({ locale: 'en', message: 'Hello, Ada!' });
    });

    it('query > header > accept-language', async () => {
      const all = await http()
        .get('/greet?name=Ada&lang=pl')
        .set('x-lang', 'de')
        .set('accept-language', 'en');
      expect(all.body.locale).toBe('pl');

      const headerAndAccept = await http()
        .get('/greet?name=Ada')
        .set('x-lang', 'de')
        .set('accept-language', 'pl');
      expect(headerAndAccept.body).toEqual({ locale: 'de', message: 'Hallo, Ada!' });

      const accept = await http()
        .get('/greet?name=Ada')
        .set('accept-language', 'pl');
      expect(accept.body).toEqual({ locale: 'pl', message: 'Cześć, Ada!' });
    });

    it('skips unsupported candidates and moves on to the next resolver', async () => {
      const res = await http()
        .get('/greet?name=Ada&lang=xx')
        .set('x-lang', 'fr')
        .set('accept-language', 'de');
      expect(res.body.locale).toBe('de');
    });

    it('honors Accept-Language q-values', async () => {
      const res = await http()
        .get('/greet?name=Ada')
        .set('accept-language', 'de;q=0.3, fr, pl;q=0.9, en;q=0.5');
      expect(res.body.locale).toBe('pl');
    });

    it('sets Content-Language and Vary for the headers the resolvers read', async () => {
      const res = await http().get('/greet?name=Ada').set('accept-language', 'pl-PL').expect(200);
      expect(res.headers['content-language']).toBe('pl');
      expect(res.headers['vary']).toBe('x-lang, Accept-Language');
      const fallback = await http().get('/users/1?lang=de').expect(404);
      expect(fallback.headers['content-language']).toBe('de');
    });

    it('keeps its Vary entries when a handler sets Vary too', async () => {
      const res = await http().get('/own-vary').set('x-lang', 'de').expect(200);
      expect(res.body.message).toBe('Sie dürfen das nicht sehen');
      expect(res.headers['vary']).toBe('X-Tenant, x-lang, Accept-Language');
    });

    it('matches the base language (pl-PL → pl)', async () => {
      const res = await http()
        .get('/greet?name=Ada')
        .set('accept-language', 'pl-PL,en;q=0.1');
      expect(res.body).toEqual({ locale: 'pl', message: 'Cześć, Ada!' });
    });

    it('uses configured region fallbacks (de-AT → de → en)', async () => {
      const res = await http().get('/greet?name=Ada&lang=de-AT');
      expect(res.body).toEqual({ locale: 'de-AT', message: 'Hallo, Ada!' });
      // "apples" is missing in de → default locale
      const apples = await http().get('/apples?count=2').set('x-lang', 'de-CH');
      expect(apples.body.message).toBe('2 apples');
    });
  });

  describe('translation', () => {
    it.each([
      [1, '1 jabłko'],
      [2, '2 jabłka'],
      [5, '5 jabłek'],
      [22, '22 jabłka'],
      [25, '25 jabłek'],
    ])('Polish plural for %i', async (count, expected) => {
      const res = await http().get(`/apples?count=${count}&lang=pl`);
      expect(res.body.message).toBe(expected);
    });

    it('English plural', async () => {
      expect((await http().get('/apples?count=1')).body.message).toBe('1 apple');
      expect((await http().get('/apples?count=5')).body.message).toBe('5 apples');
    });

    it('falls back to the default locale for a missing key', async () => {
      const res = await http().get('/english-only?lang=pl');
      expect(res.body.message).toBe('This text exists only in English');
    });
  });

  describe('exceptions', () => {
    it('translates exception messages per request locale on the same route', async () => {
      const pl = await http().get('/users/42?lang=pl').expect(404);
      expect(pl.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'Nie znaleziono użytkownika #42',
      });
      const en = await http().get('/users/42').expect(404);
      expect(en.body.message).toBe('User #42 was not found');
    });

    it('covers exceptions thrown from guards', async () => {
      const res = await http().get('/guarded').set('x-lang', 'de').expect(403);
      expect(res.body.message).toBe('Sie dürfen das nicht sehen');
    });

    it('composes with a user exception filter', async () => {
      const res = await http().get('/custom-filter/7?lang=pl').expect(404);
      expect(res.body).toEqual({
        title: 'Nie znaleziono użytkownika #7',
        status: 404,
      });
    });
  });

  describe('validation', () => {
    const invalid = { email: 'nope', name: 'Al', age: 12, nickname: '' };

    it('translates default constraint messages and explicit keys (pl)', async () => {
      const res = await http()
        .post('/users')
        .set('accept-language', 'pl-PL')
        .send(invalid)
        .expect(400);
      expect(res.body.message).toEqual([
        'email musi być poprawnym adresem e-mail',
        'name musi mieć co najmniej 3 znaki',
        'age musi wynosić co najmniej 18',
        'nickname: custom untranslated message',
      ]);
    });

    it('translates for en and falls back per key for de', async () => {
      const en = await http().post('/users').send(invalid).expect(400);
      expect(en.body.message).toEqual([
        'email must be a valid email address',
        'name must be at least 3 characters long',
        'age must be at least 18',
        'nickname: custom untranslated message',
      ]);
      const de = await http().post('/users?lang=de').send(invalid).expect(400);
      expect(de.body.message.slice(0, 2)).toEqual([
        'email muss eine gültige E-Mail-Adresse sein',
        'name must be at least 3 characters long',
      ]);
    });

    it('passes valid payloads through', async () => {
      const body = { email: 'a@b.co', name: 'Ada', age: 30, nickname: 'ada' };
      const res = await http().post('/users').send(body).expect(201);
      expect(res.body).toEqual(body);
    });
  });

  describe('standard schema validation', () => {
    const invalid = { name: 'Al', email: 'nope', age: 12, nickname: 'Ada!', referrer: 'x', coupon: 'y' };

    it('maps issue codes (Zod/Valibot/ArkType shapes) and explicit keys (pl)', async () => {
      const res = await http().post('/signup?lang=pl').send(invalid).expect(400);
      expect(res.body.message).toEqual([
        'name musi mieć co najmniej 3 znaki',
        'email musi być poprawnym adresem e-mail',
        'age musi wynosić co najmniej 18',
        'profile.nickname musi pasować do /^[a-z]+$/',
        'referrer musi wynosić co najmniej 99',
        'coupon: Coupon expired',
      ]);
    });

    it('same route in en; locales without the keys keep library messages', async () => {
      const en = await http().post('/signup').send(invalid).expect(400);
      expect(en.body.message.slice(0, 3)).toEqual([
        'name must have at least 3 characters',
        'email must be a valid email address',
        'age must be at least 18',
      ]);
      // de has no issue-code keys → falls back to en (default "fallback" policy)
      const de = await http().post('/signup?lang=de').send(invalid).expect(400);
      expect(de.body.message[0]).toBe('name must have at least 3 characters');
    });

    it('passes valid payloads', async () => {
      const body = { name: 'Ada', email: 'a@b.co', age: 30, nickname: 'ada' };
      expect((await http().post('/signup').send(body).expect(201)).body).toEqual(body);
    });
  });

  it('does not bleed locales between concurrent requests', async () => {
    const langs = ['en', 'pl', 'de', 'pl', 'en', 'de', 'pl', 'de', 'en', 'pl', 'de', 'en'];
    const expected: Record<string, [string, string]> = {
      en: ['Hello, N!', '1,234.5'],
      pl: ['Cześć, N!', '1234,5'],
      de: ['Hallo, N!', '1.234,5'],
    };
    const responses = await Promise.all(
      langs.map((lang, i) =>
        http()
          .get(`/slow?name=N&delay=${(langs.length - i) * 5}`)
          .set('x-lang', lang),
      ),
    );
    responses.forEach((res, i) => {
      const locale = langs[i];
      expect(res.body).toEqual({
        locale,
        after: locale,
        message: expected[locale][0],
        price: expected[locale][1],
      });
    });
  });
});

describe.each(adapters)('response headers with CORS over $name', ({ name }) => {
  let app: INestApplication;

  beforeAll(async () => {
    // A list of origins makes CORS add `Vary: Origin` to every response.
    app = await createApp(name, AppModule, {
      setup: (a) => a.enableCors({ origin: ['https://shop.example'] }),
    });
  });
  afterAll(() => app.close());

  it('merges its Vary entries with the ones CORS adds', async () => {
    const res = await request(app.getHttpServer())
      .get('/greet?name=Ada')
      .set('Origin', 'https://shop.example')
      .set('x-lang', 'pl')
      .expect(200);
    expect(res.body.message).toBe('Cześć, Ada!');
    expect(res.headers['content-language']).toBe('pl');
    expect(res.headers['vary']).toBe('Origin, x-lang, Accept-Language');
    // error responses too
    const missing = await request(app.getHttpServer()).get('/users/1?lang=de').expect(404);
    expect(missing.headers['vary']).toBe('Origin, x-lang, Accept-Language');
  });
});
