import {
  BadRequestException,
  Catch,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  Sse,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
  type MessageEvent,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { delay, interval, map, of, take, type Observable } from 'rxjs';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  CurrentLocale,
  HeaderLocaleResolver,
  I18nContext,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  QueryLocaleResolver,
  t,
} from '../lib/index.js';

const catalogs = {
  en: {
    orders: {
      notFound: 'Order #{id} was not found.',
      invalidId: 'The order number must be a whole number.',
      status: 'Shipped',
      products: { one: '{count} product', other: '{count} products' },
      tick: 'Update {n}',
      onlyEn: 'English only',
    },
  },
  pl: {
    orders: {
      notFound: 'Nie znaleziono zamówienia #{id}.',
      invalidId: 'Numer zamówienia musi być liczbą całkowitą.',
      status: 'Wysłane',
      products: { one: '{count} produkt', few: '{count} produkty', many: '{count} produktów', other: '{count} produktu' },
      tick: 'Aktualizacja {n}',
    },
  },
  de: {
    orders: {
      notFound: 'Bestellung #{id} wurde nicht gefunden.',
      invalidId: 'Die Bestellnummer muss eine ganze Zahl sein.',
      status: 'Versandt',
      products: { one: '{count} Produkt', other: '{count} Produkte' },
      tick: 'Aktualisierung {n}',
    },
  },
};

const placedAt = new Date('2026-09-14T15:30:00Z');

/** The tutorial's pipe: created with `new`, so its exception factory has no DI and uses `t()`. */
const orderIdPipe = new ParseIntPipe({
  exceptionFactory: () => new BadRequestException(t('orders.invalidId')),
});

@Catch(NotFoundException)
class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: NotFoundException, host: ArgumentsHost) {
    const { httpAdapter } = this.httpAdapterHost;
    const response = host.switchToHttp().getResponse();
    httpAdapter.setHeader(response, 'Content-Type', 'application/problem+json');
    httpAdapter.reply(response, { type: 'about:blank', title: 'Not Found', status: 404, detail: exception.message }, 404);
  }
}

/** Translations made at startup, outside any request. */
@Injectable()
class StartupMessages implements OnApplicationBootstrap {
  readonly values: Record<string, string> = {};

  constructor(
    private readonly i18nService: I18nService,
    private readonly i18nContext: I18nContext,
  ) {}

  onApplicationBootstrap() {
    this.values.service = this.i18nService.translate('orders.status');
    this.values.free = t('orders.status');
    this.values.locale = this.i18nContext.locale;
    this.values.job = this.i18nContext.run('pl-PL', () => `${t('orders.status')} (${this.i18nContext.locale})`);
  }
}

@Controller('orders')
class OrdersController {
  constructor(
    private readonly i18nService: I18nService,
    private readonly i18nContext: I18nContext,
    private readonly startupMessages: StartupMessages,
  ) {}

  @Get('startup')
  startup() {
    return this.startupMessages.values;
  }

  @Get('stream')
  @Sse()
  stream(): Observable<MessageEvent> {
    return interval(5).pipe(
      take(3),
      map((n) => ({ data: { locale: this.i18nContext.locale, text: t('orders.tick', { args: { n } }) } })),
    );
  }

  @Get('later')
  later(): Observable<{ status: string }> {
    return of(null).pipe(
      delay(10),
      map(() => ({ status: this.i18nService.translate('orders.status') })),
    );
  }

  /** A staff member's request about a customer: the customer's locale, not the staff member's. */
  @Get('customer-summary')
  customerSummary(@Query('customerLocale') locale: string, @CurrentLocale() staffLocale: string) {
    return {
      staffLocale,
      status: this.i18nService.translate('orders.status', { locale }),
      total: this.i18nService.formatNumber(119.95, { locale, style: 'currency', currency: 'USD' }),
      placedAt: this.i18nService.formatDate(placedAt, { locale, dateStyle: 'long', timeZone: 'UTC' }),
      hasOnlyEn: this.i18nService.exists('orders.onlyEn', locale),
      hasUnknown: this.i18nService.exists('orders.unknown', locale),
    };
  }

  @Get('nested')
  nested() {
    const outer = this.i18nContext.locale;
    const inner = this.i18nContext.run('de', () => [this.i18nContext.locale, t('orders.status')]);
    const profileWithoutLocale = this.i18nContext.run(null, () => t('orders.status'));

    return { outer, inner, profileWithoutLocale, after: [this.i18nContext.locale, t('orders.status')] };
  }

  @Get(':id')
  findOne(@Param('id', orderIdPipe) id: number) {
    if (id !== 1001) {
      throw new NotFoundException(this.i18nService.translate('orders.notFound', { args: { id } }));
    }

    return {
      id,
      status: this.i18nService.translate('orders.status'),
      products: this.i18nService.translate('orders.products', { args: { count: 5 } }),
      total: this.i18nService.formatNumber(119.95, { style: 'currency', currency: 'USD' }),
      placedAt: this.i18nService.formatDate(placedAt, { dateStyle: 'long', timeZone: 'UTC' }),
    };
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      loader: new InMemoryI18nLoader(catalogs),
      resolvers: [new QueryLocaleResolver('lang'), new HeaderLocaleResolver('x-lang')],
      logMissingKeys: 'never',
    }),
  ],
  controllers: [OrdersController],
  providers: [StartupMessages],
})
class OrdersAppModule {}

describe.each(adapters)('the request locale in application code over $name', ({ name }) => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp(name, OrdersAppModule, {
      setup: (a) => {
        a.useGlobalFilters(new ProblemDetailsFilter(a.get(HttpAdapterHost)));
      },
    });
  });
  afterAll(() => app.close());

  it('translates, pluralizes and formats numbers and dates in the request locale', async () => {
    expect((await http().get('/orders/1001?lang=pl').expect(200)).body).toEqual({
      id: 1001,
      status: 'Wysłane',
      products: '5 produktów',
      total: '119,95 USD',
      placedAt: '14 września 2026',
    });
    expect((await http().get('/orders/1001').set('x-lang', 'de').expect(200)).body).toEqual({
      id: 1001,
      status: 'Versandt',
      products: '5 Produkte',
      total: '119,95 $',
      placedAt: '14. September 2026',
    });
    expect((await http().get('/orders/1001').expect(200)).body).toMatchObject({
      total: '$119.95',
      placedAt: 'September 14, 2026',
    });
  });

  it('takes the first of repeated query parameters', async () => {
    const res = await http().get('/orders/1001?lang=pl&lang=de').expect(200);

    expect(res.body.status).toBe('Wysłane');
    expect(res.headers['content-language']).toBe('pl');
  });

  it('t() in the exception factory of a pipe created with new', async () => {
    const res = await http().get('/orders/abc?lang=pl').expect(400);

    expect(res.body.message).toBe('Numer zamówienia musi być liczbą całkowitą.');
    expect(res.headers['content-language']).toBe('pl');
  });

  it('a problem-details filter receives the translated message', async () => {
    const res = await http().get('/orders/7').set('x-lang', 'de').expect(404);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['content-language']).toBe('de');
    expect(JSON.parse(res.text)).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Bestellung #7 wurde nicht gefunden.',
    });
  });

  it("explicit locales: a customer's, matched like a request's, whatever the request's is", async () => {
    const res = await http().get('/orders/customer-summary?lang=de&customerLocale=pl-PL').expect(200);

    expect(res.body).toEqual({
      staffLocale: 'de',
      status: 'Wysłane',
      total: '119,95 USD',
      placedAt: '14 września 2026',
      hasOnlyEn: true,
      hasUnknown: false,
    });
    expect(res.headers['content-language']).toBe('de');
  });

  it.each(['__proto__', 'x', 'en_US', 'français'])(
    'an explicit locale %j from a profile gets the default locale instead of failing',
    async (customerLocale) => {
      const res = await http()
        .get('/orders/customer-summary')
        .query({ lang: 'pl', customerLocale })
        .expect(200);

      expect(res.body).toMatchObject({ status: 'Shipped', total: '$119.95', hasOnlyEn: true });
    },
  );

  it('I18nContext.run() inside a request nests a locale and restores the request one', async () => {
    const res = await http().get('/orders/nested?lang=pl').expect(200);

    expect(res.body).toEqual({
      outer: 'pl',
      inner: ['de', 'Versandt'],
      profileWithoutLocale: 'Shipped',
      after: ['pl', 'Wysłane'],
    });
  });

  it('keeps the locale for values an Observable emits later', async () => {
    const res = await http().get('/orders/later?lang=de').expect(200);

    expect(res.body).toEqual({ status: 'Versandt' });
  });

  it('keeps the locale for every server-sent event of a stream', async () => {
    const res = await http().get('/orders/stream').set('x-lang', 'pl').expect(200);

    const events = res.text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(events).toEqual([
      { locale: 'pl', text: 'Aktualizacja 0' },
      { locale: 'pl', text: 'Aktualizacja 1' },
      { locale: 'pl', text: 'Aktualizacja 2' },
    ]);
  });

  it('outside a request: I18nService uses the default locale, t() returns the key, run() enters one', async () => {
    expect((await http().get('/orders/startup?lang=pl').expect(200)).body).toEqual({
      service: 'Shipped',
      free: 'orders.status',
      locale: 'en',
      job: 'Wysłane (pl)',
    });
  });
});

describe.each(adapters)('a global prefix over $name', ({ name }) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(name, OrdersAppModule, {
      setup: (a) => {
        a.setGlobalPrefix('api');
      },
    });
  });
  afterAll(() => app.close());

  it('the middleware runs under the prefix, so routes, pipes and headers see the locale', async () => {
    const found = await request(app.getHttpServer()).get('/api/orders/1001?lang=pl').expect(200);
    expect(found.body.status).toBe('Wysłane');
    expect(found.headers['content-language']).toBe('pl');
    expect(found.headers['vary']).toBe('x-lang');

    const invalid = await request(app.getHttpServer()).get('/api/orders/abc').set('x-lang', 'de').expect(400);
    expect(invalid.body.message).toBe('Die Bestellnummer muss eine ganze Zahl sein.');
  });
});
