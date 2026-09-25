/**
 * Message formatting: the default `{name}` formatter with `{{` and `}}` for
 * literal braces, and the `formatter` option for another syntax.
 */
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  I18nContext,
  I18nMessageFormatter,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  type I18nCatalogs,
  type I18nModuleAsyncOptions,
  type I18nForRootOptions,
} from '../lib/index.js';

const catalogs: I18nCatalogs = {
  en: {
    literal: 'Write {{id}} to insert the order number, here {id}.',
    wrapped: '{{{id}}}',
    json: '{{ "id": {id} }}',
    unknown: 'Order {id} of {customer}',
    notNames: 'Keep { id }, {first-name} and {} as written.',
    lone: 'A lone { or } stays.',
    items: { one: '{count} item', other: '{count} items' },
    onlyEnglish: 'Only {what} in English',
  },
  de: {
    items: { one: '{count} Artikel', other: '{count} Artikel' },
  },
  pt: {
    items: { one: '{count} item', other: '{count} itens' },
  },
};

async function serviceWith(options: Partial<I18nForRootOptions> = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader(catalogs),
        fallbacks: { 'de-AT': 'de', 'pt-PT': 'pt' },
        logMissingKeys: 'never',
        ...options,
      }),
    ],
  }).compile();
  return moduleRef.get(I18nService);
}

describe('the default formatter', () => {
  let i18nService: I18nService;

  beforeAll(async () => {
    i18nService = await serviceWith();
  });

  it('reads {{ and }} as literal braces', () => {
    const args = { id: 1002 };

    expect(i18nService.translate('literal', { args })).toBe(
      'Write {id} to insert the order number, here 1002.',
    );
    expect(i18nService.translate('wrapped', { args })).toBe('{1002}');
    expect(i18nService.translate('json', { args })).toBe('{ "id": 1002 }');
  });

  it('leaves placeholders without an argument, and non-names, as written', () => {
    expect(i18nService.translate('unknown', { args: { id: 7 } })).toBe('Order 7 of {customer}');
    expect(i18nService.translate('notNames', { args: { id: 7 } })).toBe(
      'Keep { id }, {first-name} and {} as written.',
    );
    expect(i18nService.translate('lone')).toBe('A lone { or } stays.');
  });

  it('picks plural forms for the requested locale, also from a fallback catalog', () => {
    // Portuguese as spoken in Brazil counts 0 as "one"; in Portugal, as "other".
    expect(i18nService.translate('items', { args: { count: 0 }, locale: 'pt' })).toBe('0 item');
    expect(i18nService.translate('items', { args: { count: 0 }, locale: 'pt-PT' })).toBe('0 itens');
  });
});

/** Records what it's given, to show the arguments `format()` receives. */
class RecordingFormatter extends I18nMessageFormatter {
  format(message: string, args: Record<string, unknown>, locale: string): string {
    return `${locale}|${message}|${JSON.stringify(args)}`;
  }
}

describe('the formatter option', () => {
  it('formats every message, after the plural form is picked', async () => {
    const i18nService = await serviceWith({ formatter: new RecordingFormatter() });

    expect(i18nService.translate('items', { args: { count: 2 } })).toBe(
      'en|{count} items|{"count":2}',
    );
    expect(i18nService.translate('unknown', { args: { id: 7 } })).toBe(
      'en|Order {id} of {customer}|{"id":7}',
    );
  });

  it('gets the requested locale for its own chain, the default locale for a fallback', async () => {
    const i18nService = await serviceWith({ formatter: new RecordingFormatter() });

    expect(i18nService.translate('items', { args: { count: 1 }, locale: 'de-AT' })).toBe(
      'de-AT|{count} Artikel|{"count":1}',
    );
    expect(i18nService.translate('onlyEnglish', { locale: 'de-AT' })).toBe('en|Only {what} in English|{}');
  });

  it('formats in the current request locale', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({ loader: new InMemoryI18nLoader(catalogs), formatter: new RecordingFormatter() }),
      ],
    }).compile();

    const result = moduleRef.get(I18nContext).run('de', () => moduleRef.get(I18nService).translate('items'));
    expect(result).toBe('de|{count} Artikel|{}');
  });

  it('takes a class, which Nest instantiates with the providers of imports', async () => {
    @Injectable()
    class Brand {
      readonly name = 'Whiskers & Co.';
    }

    @Module({ providers: [Brand], exports: [Brand] })
    class BrandModule {}

    @Injectable()
    class BrandFormatter extends I18nMessageFormatter {
      constructor(private readonly brand: Brand) {
        super();
      }

      format(message: string): string {
        return message.replace('{brand}', this.brand.name);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          loader: new InMemoryI18nLoader({ en: { signature: 'Your {brand} team' } }),
          formatter: BrandFormatter,
          imports: [BrandModule],
        }),
      ],
    }).compile();

    expect(moduleRef.get(I18nService).translate('signature')).toBe('Your Whiskers & Co. team');
  });

  describe('in forRootAsync()', () => {
    const compile = (options: I18nModuleAsyncOptions) =>
      Test.createTestingModule({ imports: [I18nModule.forRootAsync(options)] }).compile();

    it('takes an instance from the factory', async () => {
      const moduleRef = await compile({
        loader: new InMemoryI18nLoader(catalogs),
        useFactory: () => ({ formatter: new RecordingFormatter() }),
      });

      expect(moduleRef.get(I18nService).translate('lone')).toBe('en|A lone { or } stays.|{}');
    });

    it('takes a class at the top level', async () => {
      const moduleRef = await compile({
        loader: new InMemoryI18nLoader(catalogs),
        formatter: RecordingFormatter,
        useFactory: () => ({}),
      });

      expect(moduleRef.get(I18nService).translate('lone')).toBe('en|A lone { or } stays.|{}');
    });

    it('refuses a class from the factory, and a formatter set in both places', async () => {
      await expect(
        compile({
          loader: new InMemoryI18nLoader(catalogs),
          useFactory: () => ({ formatter: RecordingFormatter as unknown as I18nMessageFormatter }),
        }),
      ).rejects.toThrow(/returned the class RecordingFormatter in "formatter"/);

      await expect(
        compile({
          loader: new InMemoryI18nLoader(catalogs),
          formatter: RecordingFormatter,
          useFactory: () => ({ formatter: new RecordingFormatter() }),
        }),
      ).rejects.toThrow(/"formatter" is set both at the top level/);
    });
  });
});
