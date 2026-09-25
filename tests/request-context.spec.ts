import { Injectable, Module, type ExecutionContext } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { defer, lastValueFrom, map, of, throwError, timer, toArray, type Observable } from 'rxjs';
import { I18nInterceptor } from '../lib/interceptors/i18n.interceptor.js';
import { I18nMiddleware } from '../lib/middleware/i18n.middleware.js';
import {
  AcceptLanguageLocaleResolver,
  I18N_MODULE_OPTIONS,
  I18nContext,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  t,
  type I18nForRootOptions,
  type LocaleResolverInput,
} from '../lib/index.js';
import { LocaleResolution } from '../lib/services/locale-resolution.service.js';

const loader = new InMemoryI18nLoader({
  en: { hi: 'Hi', apples: { one: '{count} apple', other: '{count} apples' } },
  pl: { hi: 'Cześć', apples: { one: '{count} jabłko', few: '{count} jabłka', many: '{count} jabłek', other: '{count} jabłka' } },
});

async function compile(options: Partial<I18nForRootOptions> = {}) {
  return Test.createTestingModule({ imports: [I18nModule.forRoot({ loader, ...options })] }).compile();
}

describe('I18nContext and t()', () => {
  let context: I18nContext;

  beforeAll(async () => {
    context = (await compile()).get(I18nContext);
  });

  it('restores the outer locale after a nested run()', () => {
    const seen = context.run('pl', () => {
      const inner = context.run('en', () => context.locale);
      return [inner, context.locale];
    });
    expect(seen).toEqual(['en', 'pl']);
    expect(context.locale).toBe('en');
  });

  it('keeps the locale across awaits and timers, and returns what the callback returns', async () => {
    const result = context.run('pl', async () => {
      await Promise.resolve();
      const afterAwait = t('hi');
      const afterTimer = await new Promise((resolve) => setTimeout(() => resolve(context.locale), 0));
      return [afterAwait, afterTimer];
    });
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual(['Cześć', 'pl']);
  });

  it('isolates concurrent runs', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const results = await Promise.all(
      ['pl', 'en', 'pl', 'en'].map((locale) =>
        context.run(locale, async () => {
          await tick();
          await tick();
          return t('hi');
        }),
      ),
    );
    expect(results).toEqual(['Cześć', 'Hi', 'Cześć', 'Hi']);
  });

  it('t() selects plural forms for the current locale', () => {
    expect(context.run('pl', () => [2, 5].map((count) => t('apples', { args: { count } })))).toEqual([
      '2 jabłka',
      '5 jabłek',
    ]);
  });

  it('run() gives a malformed locale the default locale', () => {
    expect(context.run('e!n', () => context.locale)).toBe('en');
    expect(context.run('', () => context.locale)).toBe('en');
  });
});

describe('the module', () => {
  it('is global: feature modules inject I18nService and I18nContext without importing it', async () => {
    @Injectable()
    class Greeter {
      constructor(
        private readonly i18n: I18nService,
        private readonly context: I18nContext,
      ) {}
      greet() {
        return `${this.context.locale}: ${this.i18n.t('hi')}`;
      }
    }
    @Module({ providers: [Greeter], exports: [Greeter] })
    class FeatureModule {}

    const ref = await Test.createTestingModule({
      imports: [I18nModule.forRoot({ loader }), FeatureModule],
    }).compile();
    const context = ref.get(I18nContext);
    expect(context.run('pl', () => ref.get(Greeter).greet())).toBe('pl: Cześć');
  });

  it('reads Accept-Language when no resolvers are configured', async () => {
    for (const ref of [
      await compile(),
      await Test.createTestingModule({
        imports: [I18nModule.forRootAsync({ useFactory: () => ({ loader }) })],
      }).compile(),
    ]) {
      const resolution = ref.get(LocaleResolution);
      expect(resolution.varyHeaders).toEqual(['Accept-Language']);
      expect(await resolution.resolve({ headers: { 'accept-language': 'pl-PL' }, query: {} })).toBe('pl');
    }
  });

  it('instantiates a resolver class listed twice once', async () => {
    let instances = 0;
    @Injectable()
    class CountingResolver extends LocaleResolver {
      constructor() {
        super();
        instances++;
      }
      resolve() {
        return undefined;
      }
    }
    const ref = await compile({ resolvers: [CountingResolver, new QueryLocaleResolver(), CountingResolver] });
    expect(await ref.get(LocaleResolution).resolve({ headers: {}, query: { lang: 'pl' } })).toBe('pl');
    expect(instances).toBe(1);
  });
});

describe('I18nMiddleware', () => {
  let ref: TestingModule;

  const middlewareOf = (moduleRef: TestingModule) =>
    new I18nMiddleware(
      moduleRef.get(LocaleResolution),
      moduleRef.get(I18nService),
      moduleRef.get(I18N_MODULE_OPTIONS),
    );

  beforeAll(async () => {
    ref = await compile({ resolvers: [new QueryLocaleResolver(), new AcceptLanguageLocaleResolver()] });
  });

  it('runs the rest of the pipeline in the locale context', async () => {
    const context = ref.get(I18nContext);
    let seen: unknown[] = [];
    await middlewareOf(ref).use({ headers: {}, url: '/?lang=pl' }, {}, () => {
      seen = [context.locale, t('hi')];
    });
    expect(seen).toEqual(['pl', 'Cześć']);
  });

  it('prefers originalUrl, which a mounted router does not rewrite', async () => {
    const headers: Record<string, string> = {};
    await middlewareOf(ref).use(
      { headers: {}, url: '/', originalUrl: '/api/?lang=pl' },
      { setHeader: (name: string, value: string) => (headers[name] = value) },
      () => {},
    );
    expect(headers['Content-Language']).toBe('pl');
  });

  it('sets no Vary header when the resolvers read no headers', async () => {
    const queryOnly = await compile({ resolvers: [new QueryLocaleResolver()] });
    const headers: Record<string, string> = {};
    await middlewareOf(queryOnly).use(
      { headers: {}, url: '/?lang=pl' },
      { setHeader: (name: string, value: string) => (headers[name] = value), writeHead: () => {} },
      () => {},
    );
    expect(headers).toEqual({ 'Content-Language': 'pl' });
  });

  it('merges into a Vary header held as an array', async () => {
    const headers: Record<string, unknown> = { vary: ['Origin', 'X-Tenant'] };
    await middlewareOf(ref).use(
      { headers: { 'accept-language': 'pl' }, url: '/' },
      {
        getHeader: (name: string) => headers[name.toLowerCase()],
        setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value),
      },
      () => {},
    );
    expect(headers.vary).toBe('Origin, X-Tenant, Accept-Language');
  });

  it('merges into writeHead() headers once, even when writeHead() is called again', async () => {
    const calls: unknown[][] = [];
    const res = {
      getHeader: () => undefined,
      setHeader: () => {},
      writeHead: (...args: unknown[]) => calls.push(args),
    };
    await middlewareOf(ref).use({ headers: {}, url: '/' }, res, () => {});
    res.writeHead(200, { Vary: 'Origin' });
    res.writeHead(200, { Vary: 'Origin' });
    expect(calls).toEqual([
      [200, { Vary: 'Origin, Accept-Language' }],
      [200, { Vary: 'Origin' }],
    ]);
  });

  it('works with a response that cannot take headers', async () => {
    const next = vi.fn();
    await middlewareOf(ref).use({ headers: {}, url: '/?lang=pl' }, {}, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('I18nInterceptor', () => {
  let ref: TestingModule;
  let interceptor: I18nInterceptor;
  let context: I18nContext;
  let inputs: LocaleResolverInput[];

  beforeAll(async () => {
    class RecordingResolver extends LocaleResolver {
      resolve(input: LocaleResolverInput) {
        inputs.push(input);
        return undefined;
      }
    }
    ref = await compile({
      resolvers: [new RecordingResolver(), new QueryLocaleResolver(), new AcceptLanguageLocaleResolver()],
    });
    interceptor = new I18nInterceptor(ref.get(LocaleResolution), ref.get(I18nService));
    context = ref.get(I18nContext);
  });
  beforeEach(() => {
    inputs = [];
  });

  const intercept = <T>(ctx: object, handle: () => Observable<T>) =>
    lastValueFrom(interceptor.intercept(ctx as ExecutionContext, { handle }).pipe(toArray()));

  const http = (request: object) => ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  });

  it('keeps the locale the middleware (or run()) already entered, without resolving again', async () => {
    const result = await context.run('pl', () =>
      intercept(http({ headers: { 'accept-language': 'en' }, query: {} }), () => of(context.locale)),
    );
    expect(result).toEqual(['pl']);
    expect(inputs).toEqual([]);
  });

  it('keeps the locale for values emitted later and for lazily created streams', async () => {
    const result = await intercept(http({ headers: {}, query: { lang: 'pl' } }), () =>
      defer(() => timer(0).pipe(map(() => [context.locale, t('hi')]))),
    );
    expect(result).toEqual([['pl', 'Cześć']]);
  });

  it('parses the query from the URL when the request has none parsed', async () => {
    const result = await intercept(http({ headers: {}, url: '/x?lang=pl' }), () => defer(() => of(context.locale)));
    expect(result).toEqual(['pl']);
  });

  it('reads the request Mercurius puts on the GraphQL context', async () => {
    const result = await intercept(
      {
        getType: () => 'graphql',
        getArgByIndex: (index: number) =>
          index === 2 ? { reply: { request: { headers: { 'accept-language': 'pl' } } } } : undefined,
      },
      () => defer(() => of(context.locale)),
    );
    expect(result).toEqual(['pl']);
  });

  it('gives resolvers empty headers and query, and the execution context, on other transports', async () => {
    const ctx = { getType: () => 'custom' };
    const result = await intercept(ctx, () => defer(() => of(context.locale)));
    expect(result).toEqual(['en']);
    expect(inputs).toEqual([{ headers: {}, query: {}, executionContext: ctx }]);
  });

  it('skips a WebSocket handshake without headers', async () => {
    const result = await intercept(
      {
        getType: () => 'ws',
        switchToWs: () => ({
          getClient: () => ({ handshake: { query: { lang: 'en' } }, request: { headers: {}, url: '/?lang=pl' } }),
        }),
      },
      () => defer(() => of(context.locale)),
    );
    expect(result).toEqual(['pl']);
  });

  it('passes errors from the handler through', async () => {
    await expect(
      intercept(http({ headers: {}, query: { lang: 'pl' } }), () =>
        defer(() => throwError(() => new Error(t('hi')))),
      ),
    ).rejects.toThrow('Cześć');
  });
});
