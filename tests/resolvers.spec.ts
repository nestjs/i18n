import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AcceptLanguageLocaleResolver,
  CookieLocaleResolver,
  HeaderLocaleResolver,
  I18nModule,
  InMemoryI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  type LocaleResolverInput,
} from '../lib/index.js';
import { parseAcceptLanguage } from '../lib/resolvers/accept-language-locale.resolver.js';
import { LocaleResolution } from '../lib/services/locale-resolution.service.js';

const input = (headers: LocaleResolverInput['headers'] = {}, query: Record<string, unknown> = {}) => ({
  headers,
  query,
});

describe('HeaderLocaleResolver', () => {
  it('reads a header named in any case, and lists it in Vary as configured', () => {
    const resolver = new HeaderLocaleResolver('X-Locale');
    expect(resolver.resolve(input({ 'x-locale': 'pl' }))).toBe('pl');
    expect(resolver.varyHeaders).toEqual(['X-Locale']);
    expect(new HeaderLocaleResolver().varyHeaders).toEqual(['x-lang']);
  });

  it('takes the first value of a repeated header, and none from an empty one', () => {
    const resolver = new HeaderLocaleResolver();
    expect(resolver.resolve(input({ 'x-lang': ['de', 'pl'] }))).toBe('de');
    expect(resolver.resolve(input({ 'x-lang': '' }))).toBeUndefined();
    expect(resolver.resolve(input({ 'x-lang': [] }))).toBeUndefined();
  });
});

describe('QueryLocaleResolver', () => {
  it('reads a custom parameter, the first of repeated ones, and only strings', () => {
    const resolver = new QueryLocaleResolver('locale');
    expect(resolver.resolve(input({}, { locale: 'pl', lang: 'de' }))).toBe('pl');
    expect(resolver.resolve(input({}, { locale: ['de', 'pl'] }))).toBe('de');
    // qs parses `?locale[a]=1` into an object
    expect(resolver.resolve(input({}, { locale: { a: '1' } }))).toBeUndefined();
    expect(resolver.resolve(input({}, { locale: '' }))).toBeUndefined();
  });

  it('reads no headers, so it adds nothing to Vary', () => {
    expect(new QueryLocaleResolver().varyHeaders).toBeUndefined();
  });
});

describe('AcceptLanguageLocaleResolver', () => {
  const resolver = new AcceptLanguageLocaleResolver();

  it('returns every candidate in preference order', () => {
    expect(resolver.resolve(input({ 'accept-language': 'de;q=0.5, pl' }))).toEqual(['pl', 'de']);
  });

  it('returns nothing without the header', () => {
    expect(resolver.resolve(input())).toBeUndefined();
    expect(resolver.resolve(input({ 'accept-language': '' }))).toBeUndefined();
  });

  it('parseAcceptLanguage skips empty entries and reads q among other parameters', () => {
    expect(parseAcceptLanguage(' , pl ,, de;level=1;q=0.4 ,en;q=0.5')).toEqual(['pl', 'en', 'de']);
    expect(parseAcceptLanguage('')).toEqual([]);
    expect(parseAcceptLanguage('*')).toEqual([]);
  });
});

describe('CookieLocaleResolver', () => {
  const resolve = (cookie: string, name?: string) =>
    new CookieLocaleResolver(name).resolve(input({ cookie }));

  it('decodes a percent-encoded value, and keeps a malformed one as it is', () => {
    expect(resolve('lang=pt%2DBR')).toBe('pt-BR');
    expect(resolve('lang=pl%E0%A4%A')).toBe('pl%E0%A4%A');
  });

  it('matches the whole cookie name, around spaces and pairs without a value', () => {
    expect(resolve('mylang=de;flag; lang = pl ')).toBe('pl');
    expect(resolve('language=de', 'lang')).toBeUndefined();
  });

  it('reads the first of two cookies with the name', () => {
    expect(resolve('lang=pl; lang=de')).toBe('pl');
  });

  it('keeps a lone double quote', () => {
    expect(resolve('lang="')).toBe('"');
    expect(resolve('lang=""')).toBeUndefined();
  });
});

describe('LocaleResolution', () => {
  async function resolution(resolvers: LocaleResolver[]) {
    const ref = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          loader: new InMemoryI18nLoader({ en: {}, pl: {}, de: {} }),
          resolvers,
        }),
      ],
    }).compile();
    return ref.get(LocaleResolution);
  }

  const fixed = (result: unknown, varyHeaders?: string[]): LocaleResolver =>
    Object.assign(Object.create(LocaleResolver.prototype), {
      varyHeaders,
      resolve: () => result,
    });

  it('logs a resolver that throws or rejects, and moves on to the next one', async () => {
    class ProfileLocaleResolver extends LocaleResolver {
      resolve(): string {
        throw new Error('profile service is down');
      }
    }
    class RemoteLocaleResolver extends LocaleResolver {
      async resolve(): Promise<string> {
        throw new Error('timeout');
      }
    }
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const subject = await resolution([
        new ProfileLocaleResolver(),
        new RemoteLocaleResolver(),
        new QueryLocaleResolver(),
      ]);
      expect(await subject.resolve(input({}, { lang: 'pl' }))).toBe('pl');
      expect(error.mock.calls.map(([message]) => message)).toEqual([
        'Locale resolver ProfileLocaleResolver failed: Error: profile service is down',
        'Locale resolver RemoteLocaleResolver failed: Error: timeout',
      ]);
      expect(String(error.mock.calls[0][1])).toContain('profile service is down');
    } finally {
      error.mockRestore();
    }
  });

  it('awaits async resolvers', async () => {
    const subject = await resolution([fixed(Promise.resolve('de'))]);
    expect(await subject.resolve(input())).toBe('de');
  });

  it('skips candidates that are not strings, and nothing at all', async () => {
    const subject = await resolution([
      fixed(null),
      fixed([undefined, 42, { locale: 'pl' }, 'fr', 'pl-PL']),
    ]);
    expect(await subject.resolve(input())).toBe('pl');
    expect(await (await resolution([fixed(undefined), fixed([])])).resolve(input())).toBe('en');
  });

  it('lists each header once in Vary, compared case-insensitively, in resolver order', async () => {
    const subject = await resolution([
      new CookieLocaleResolver(),
      fixed(undefined, ['accept-language', 'X-Tenant']),
      new AcceptLanguageLocaleResolver(),
      new HeaderLocaleResolver('x-tenant'),
    ]);
    expect(subject.varyHeaders).toEqual(['Cookie', 'accept-language', 'X-Tenant']);
  });
});
