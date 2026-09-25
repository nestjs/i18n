import {
  BadRequestException,
  Body,
  Controller,
  Injectable,
  Module,
  Post,
  Query,
  StandardSchemaValidationPipe,
  UsePipes,
  type ArgumentMetadata,
  type INestApplication,
  type PipeTransform,
} from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import request from 'supertest';
import { z } from 'zod';
import { adapters, createApp } from './support/adapters.js';
import {
  HeaderLocaleResolver,
  I18nModule,
  i18nIssueMessage,
  I18nStandardSchemaValidationPipe,
  InMemoryI18nLoader,
  translateStandardSchemaIssues,
} from '../lib/index.js';

const plural = (one: string, few: string, many: string) => ({ one, few, many, other: few });

const catalogs = {
  en: {
    validation: {
      invalid_type: '{path} must be a {expected}',
      too_small: {
        string: { one: '{path} must be at least {count} character long', other: '{path} must be at least {count} characters long' },
        number: '{path} must be at least {minimum}',
        array: '{path} must contain at least one item',
      },
      too_big: '{path} must be at most {maximum}',
      invalid_format: {
        email: '{property} must be a valid email address',
      },
    },
    signup: { invalid_format: '{property} is not in the expected format' },
    orders: { unknownProduct: 'Product #{id} is not in our catalog.' },
  },
  pl: {
    validation: {
      invalid_type: '{path} musi być typu {expected}',
      too_small: {
        string: plural(
          '{path} musi mieć co najmniej {count} znak',
          '{path} musi mieć co najmniej {count} znaki',
          '{path} musi mieć co najmniej {count} znaków',
        ),
        number: '{path} musi wynosić co najmniej {minimum}',
        array: '{path} musi zawierać co najmniej jedną pozycję',
      },
      too_big: '{path} może wynosić najwyżej {maximum}',
      invalid_format: {
        email: '{property} musi być poprawnym adresem e-mail',
        regex: '{path} ma niepoprawny format (oryginalnie: {message})',
      },
      invalid_value: { enum: '{path}: niedozwolona wartość' },
    },
    signup: {
      invalid_format: '{property} ma niepoprawny format',
      invalid_value: { enum: '{property}: wybierz jedną z dozwolonych wartości' },
    },
    orders: { unknownProduct: 'Produktu #{id} nie ma w naszym katalogu.' },
  },
};

const CreateOrder = z.object({
  items: z
    .array(
      z.object({
        productId: z.number().int().refine((id) => id < 100, i18nIssueMessage('orders.unknownProduct', { id: 100 })),
        quantity: z.number().min(1).max(10),
      }),
    )
    .min(1),
  address: z.object({
    recipient: z.string().min(2),
    postalCode: z.string().regex(/^\d{2}-\d{3}$/),
    country: z.enum(['US', 'PL', 'DE']),
  }),
  contact: z.email(),
  note: z.string().trim().min(5).optional(),
});

/** Zod 4 reports no origin for enums: the app adds its own candidate key. */
const enumKeys = (issue: StandardSchemaV1.Issue) =>
  (issue as { code?: string }).code === 'invalid_value' ? ['invalid_value.enum'] : [];

const Search = z.object({ q: z.string().min(5), page: z.coerce.number().min(1) });

/** An app's own pipe: translates issues, then answers in its own shape. */
@Injectable()
class ProblemSchemaPipe implements PipeTransform {
  async transform(value: unknown, { schema }: ArgumentMetadata) {
    if (!schema) {
      return value;
    }

    const result = await (schema as StandardSchemaV1)['~standard'].validate(value);
    if (result.issues) {
      throw new BadRequestException({
        title: 'Invalid request',
        errors: translateStandardSchemaIssues(result.issues).map((issue) => ({
          path: issue.path?.join('.'),
          detail: issue.message,
        })),
      });
    }
    return result.value;
  }
}

@Controller()
class OrdersController {
  @Post('orders')
  create(@Body({ schema: CreateOrder }) body: z.infer<typeof CreateOrder>) {
    return body;
  }

  @Post('search')
  search(@Query({ schema: Search }) query: z.infer<typeof Search>) {
    return query;
  }
}

@Controller('scoped')
class ScopedController {
  @Post('namespace')
  @UsePipes(new I18nStandardSchemaValidationPipe({ namespace: 'signup', issueKeys: enumKeys }))
  namespace(@Body({ schema: CreateOrder }) body: unknown) {
    return body;
  }

  @Post('issue-keys')
  @UsePipes(new I18nStandardSchemaValidationPipe({ issueKeys: enumKeys }))
  issueKeys(@Body({ schema: CreateOrder }) body: unknown) {
    return body;
  }

  @Post('factory')
  @UsePipes(
    new I18nStandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new BadRequestException({
          issues: issues.map(({ path, message, ...rest }) => ({
            path: path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.'),
            message,
            code: (rest as { code?: string }).code,
            minimum: (rest as { minimum?: number }).minimum,
          })),
        }),
    }),
  )
  factory(@Body({ schema: CreateOrder }) body: unknown) {
    return body;
  }

  @Post('own-pipe')
  @UsePipes(ProblemSchemaPipe)
  ownPipe(@Body({ schema: CreateOrder }) body: unknown) {
    return body;
  }

  @Post('nest-pipe')
  @UsePipes(new StandardSchemaValidationPipe())
  nestPipe(@Body({ schema: CreateOrder }) body: unknown) {
    return body;
  }
}

function appModule(global: boolean) {
  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader(catalogs),
        resolvers: [new HeaderLocaleResolver('x-lang')],
        logMissingKeys: 'never',
      }),
    ],
    controllers: global ? [OrdersController] : [ScopedController],
    providers: global ? [{ provide: APP_PIPE, useValue: new I18nStandardSchemaValidationPipe({ transform: true }) }] : [],
  })
  class StandardSchemaAppModule {}

  return StandardSchemaAppModule;
}

const valid = {
  items: [{ productId: 1, quantity: 2 }],
  address: { recipient: 'Zofia', postalCode: '00-950', country: 'PL' },
  contact: 'zofia@example.com',
};

const invalid = {
  items: [{ productId: 100, quantity: 11 }, { productId: 'x', quantity: 0 }],
  address: { recipient: 'Z', postalCode: '00950', country: 'FR' },
  contact: 'nope',
  note: '  ab   ',
};

describe.each(adapters)('Standard Schema (Zod 4) messages over $name', ({ name }) => {
  let app: INestApplication;
  let scoped: INestApplication;
  const post = (path: string, body: object, locale = 'en') =>
    request((path.startsWith('/scoped') ? scoped : app).getHttpServer()).post(path).set('x-lang', locale).send(body);

  beforeAll(async () => {
    app = await createApp(name, appModule(true));
    scoped = await createApp(name, appModule(false));
  });
  afterAll(async () => {
    await app.close();
    await scoped.close();
  });

  it('bound with APP_PIPE: keys by code, format and origin, plurals by count, explicit keys; untranslated codes keep Nest\'s format', async () => {
    const res = await post('/orders', invalid, 'pl').expect(400);

    expect(res.body.message).toEqual([
      'Produktu #100 nie ma w naszym katalogu.',
      'items.0.quantity może wynosić najwyżej 10',
      'items.1.productId musi być typu number',
      'items.1.quantity musi wynosić co najmniej 1',
      'address.recipient musi mieć co najmniej 2 znaki',
      'address.postalCode ma niepoprawny format (oryginalnie: Invalid string: must match pattern /^\\d{2}-\\d{3}$/)',
      'address.country: Invalid option: expected one of "US"|"PL"|"DE"',
      'contact musi być poprawnym adresem e-mail',
      'note musi mieć co najmniej 5 znaków',
    ]);
    expect(res.headers['content-language']).toBe('pl');
  });

  it('the same route in English, where a missing <code>.<format> key keeps the library message', async () => {
    const res = await post('/orders', invalid).expect(400);

    expect(res.body.message).toEqual([
      'Product #100 is not in our catalog.',
      'items.0.quantity must be at most 10',
      'items.1.productId must be a number',
      'items.1.quantity must be at least 1',
      'address.recipient must be at least 2 characters long',
      'address.postalCode: Invalid string: must match pattern /^\\d{2}-\\d{3}$/',
      'address.country: Invalid option: expected one of "US"|"PL"|"DE"',
      'contact must be a valid email address',
      'note must be at least 5 characters long',
    ]);
  });

  it('an empty array, by origin', async () => {
    const res = await post('/orders', { ...valid, items: [] }, 'pl').expect(400);

    expect(res.body.message).toEqual(['items musi zawierać co najmniej jedną pozycję']);
  });

  it('passes the parsed value on, with the schema\'s transforms', async () => {
    const res = await post('/orders', { ...valid, note: '  gift wrap  ' }, 'pl').expect(201);

    expect(res.body).toEqual({ ...valid, note: 'gift wrap' });
  });

  it('validates query parameters with a schema', async () => {
    const invalidQuery = await request(app.getHttpServer()).post('/search?q=abc&page=0').set('x-lang', 'pl').expect(400);
    expect(invalidQuery.body.message).toEqual(['q musi mieć co najmniej 5 znaków', 'page musi wynosić co najmniej 1']);

    const validQuery = await request(app.getHttpServer()).post('/search?q=tolkien&page=2').expect(201);
    expect(validQuery.body).toEqual({ q: 'tolkien', page: 2 });
  });

  it('namespace reads issue-code keys from another namespace, issueKeys from it too', async () => {
    const res = await post('/scoped/namespace', { ...valid, address: { ...valid.address, postalCode: 'x', country: 'FR' } }, 'pl').expect(400);

    expect(res.body.message).toEqual([
      'postalCode ma niepoprawny format',
      'country: wybierz jedną z dozwolonych wartości',
    ]);
  });

  it('issueKeys are tried before the built-in keys', async () => {
    const res = await post('/scoped/issue-keys', { ...valid, address: { ...valid.address, country: 'FR' } }, 'pl').expect(400);

    expect(res.body.message).toEqual(['address.country: niedozwolona wartość']);
  });

  it('a custom exceptionFactory receives translated issues with their other fields', async () => {
    const res = await post('/scoped/factory', { ...valid, address: { ...valid.address, recipient: 'Z' } }, 'pl').expect(400);

    expect(res.body).toEqual({
      issues: [{ path: 'address.recipient', message: 'address.recipient musi mieć co najmniej 2 znaki', code: 'too_small', minimum: 2 }],
    });
  });

  it("an app's own pipe localizes issues with translateStandardSchemaIssues()", async () => {
    const res = await post('/scoped/own-pipe', { ...valid, contact: 'nope' }, 'pl').expect(400);

    expect(res.body).toEqual({
      title: 'Invalid request',
      errors: [{ path: 'contact', detail: 'contact musi być poprawnym adresem e-mail' }],
    });
  });

  it("Nest's own pipe reports an explicit key as it is", async () => {
    const res = await post('/scoped/nest-pipe', { ...valid, items: [{ productId: 100, quantity: 1 }] }, 'pl').expect(400);

    expect(res.body.message).toEqual(['items.0.productId: $i18n:orders.unknownProduct|{"id":100}']);
  });
});
