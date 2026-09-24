import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  I18nMissingKeyError,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  type I18nModuleOptions,
} from '../lib/index.js';

const loader = new InMemoryI18nLoader({
  en: { hello: 'Hello', onlyEn: 'English only' },
  de: { hello: 'Hallo' },
});

async function service(options: Partial<I18nModuleOptions>) {
  const ref = await Test.createTestingModule({
    imports: [
      I18nModule.forRoot({
        defaultLocale: 'en',
        fallbacks: { 'de-AT': 'de' },
        loader,
        ...options,
      }),
    ],
  }).compile();
  return ref.get(I18nService);
}

describe('missing-key policy', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('fallback (default): default locale, then the key; warns once each', async () => {
    const i18n = await service({});
    expect(i18n.translate('onlyEn', { locale: 'de' })).toBe('English only');
    expect(i18n.translate('nope', { locale: 'de' })).toBe('nope');
    expect(i18n.translate('nope', { locale: 'de' })).toBe('nope');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('fallback warns when the default locale fills in, once per key and locale', async () => {
    const i18n = await service({});
    for (let i = 0; i < 3; i++) {
      expect(i18n.translate('onlyEn', { locale: 'de' })).toBe('English only');
    }
    expect(i18n.translate('onlyEn', { locale: 'de-AT' })).toBe('English only');
    expect(warn.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'Missing translation "onlyEn" for locale "de"; using "en"',
      'Missing translation "onlyEn" for locale "de-AT"; using "en"',
    ]);
  });

  it('fallback does not warn for region → base, or in the default locale', async () => {
    const i18n = await service({});
    expect(i18n.translate('hello', { locale: 'de-AT' })).toBe('Hallo');
    expect(i18n.translate('onlyEn', { locale: 'en' })).toBe('English only');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logMissingKeys: never silences fallback warnings too', async () => {
    const i18n = await service({ logMissingKeys: 'never' });
    expect(i18n.translate('onlyEn', { locale: 'de' })).toBe('English only');
    expect(warn).not.toHaveBeenCalled();
  });

  it('key: no jump to the default locale, but region → base still applies', async () => {
    const i18n = await service({ missingKey: 'key' });
    expect(i18n.translate('onlyEn', { locale: 'de' })).toBe('onlyEn');
    expect(i18n.translate('hello', { locale: 'de-AT' })).toBe('Hallo');
    expect(i18n.translate('onlyEn', { locale: 'en' })).toBe('English only');
    expect(i18n.exists('onlyEn', 'de')).toBe(false);
  });

  it('empty', async () => {
    const i18n = await service({ missingKey: 'empty' });
    expect(i18n.translate('onlyEn', { locale: 'de' })).toBe('');
  });

  it('throw', async () => {
    const i18n = await service({ missingKey: 'throw' });
    expect(() => i18n.translate('onlyEn', { locale: 'de' })).toThrow(I18nMissingKeyError);
    expect(() => i18n.translate('onlyEn', { locale: 'de' })).toThrow(
      'Missing translation "onlyEn" for locale "de"',
    );
  });

  it('function', async () => {
    const i18n = await service({ missingKey: (key, locale) => `[${locale}] ${key}` });
    expect(i18n.translate('onlyEn', { locale: 'de' })).toBe('[de] onlyEn');
  });

  it.each([
    ['once', 1],
    ['always', 3],
    ['never', 0],
  ] as const)('logMissingKeys: %s', async (logMissingKeys, calls) => {
    const i18n = await service({ logMissingKeys });
    for (let i = 0; i < 3; i++) {
      i18n.translate('nope');
    }
    expect(warn).toHaveBeenCalledTimes(calls);
  });
});
