import {
  BadRequestException,
  Body,
  Controller,
  Injectable,
  Logger,
  Module,
  Post,
  Query,
  UsePipes,
  type ArgumentMetadata,
  type INestApplication,
  type PipeTransform,
  type ValidationError,
} from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsEmail,
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  MinLength,
  validate,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  HeaderLocaleResolver,
  I18nModule,
  i18nValidationMessage,
  I18nValidationPipe,
  InMemoryI18nLoader,
  QueryLocaleResolver,
  translateValidationErrors,
  type I18nForRootOptions,
} from '../lib/index.js';

const plural = (one: string, few: string, many: string) => ({ one, few, many, other: few });

const catalogs = {
  en: {
    validation: {
      isInt: '{path} must be a whole number',
      min: '{path} must be at least {constraint1}',
      arrayNotEmpty: '{path} must contain at least one item',
      minLength: { one: '{path} must be at least {count} character long', other: '{path} must be at least {count} characters long' },
      matches: '{path} has an invalid format',
      isEmail: '{property} must be an email address, not "{value}"',
      isIn: '{property} must be one of {constraint1}',
      isPrime: '{property} must be a prime number, not {value}',
    },
    forms: { isEmail: 'Please enter a valid email address' },
    orders: {
      tooManyUnits: { one: '{path} must not exceed {count} unit per product', other: '{path} must not exceed {count} units per product' },
      unsupportedCountry: 'We only ship to the United States, Poland and Germany.',
      adminsOnly: '{property} needs at least {constraint1} characters for admins',
    },
  },
  pl: {
    validation: {
      isInt: '{path} musi być liczbą całkowitą',
      min: '{path} musi wynosić co najmniej {constraint1}',
      arrayNotEmpty: '{path} musi zawierać co najmniej jedną pozycję',
      minLength: plural(
        '{path} musi mieć co najmniej {count} znak',
        '{path} musi mieć co najmniej {count} znaki',
        '{path} musi mieć co najmniej {count} znaków',
      ),
      matches: '{path} ma niepoprawny format',
      isEmail: '{property} musi być adresem e-mail, a nie „{value}”',
      isIn: '{property} musi być jednym z: {constraint1}',
      isPrime: '{property} musi być liczbą pierwszą, a nie {value}',
    },
    forms: { isEmail: 'Podaj poprawny adres e-mail' },
    orders: {
      tooManyUnits: plural(
        '{path} nie może przekraczać {count} sztuki na produkt',
        '{path} nie może przekraczać {count} sztuk na produkt',
        '{path} nie może przekraczać {count} sztuk na produkt',
      ),
      unsupportedCountry: 'Wysyłamy tylko do Stanów Zjednoczonych, Polski i Niemiec.',
    },
  },
};

class OrderItemDto {
  @IsInt()
  productId: number;

  @IsInt()
  @Min(1)
  @Max(10, { message: i18nValidationMessage('orders.tooManyUnits') })
  quantity: number;
}

class CreateOrderDto {
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}

class ShippingAddressDto {
  @MinLength(2)
  recipient: string;

  @Matches(/^[0-9-]{5,6}$/)
  postalCode: string;

  @IsIn(['US', 'PL', 'DE'], { message: i18nValidationMessage('orders.unsupportedCountry') })
  country: string;

  @MinLength(2, { message: 'city: kept as the app wrote it' })
  city: string;
}

class TagsDto {
  @MinLength(3, { each: true })
  tags: string[];
}

@ValidatorConstraint({ name: 'isPrime' })
class IsPrime implements ValidatorConstraintInterface {
  validate(value: number) {
    return Number.isInteger(value) && value > 1 && [...Array(value).keys()].slice(2).every((d) => value % d !== 0);
  }

  defaultMessage() {
    return '$property is not prime';
  }
}

class ContactDto {
  @IsEmail()
  email: string;

  @Validate(IsPrime)
  lucky: number;
}

class SearchDto {
  @MinLength(3)
  q: string;
}

class RoleDto {
  @MinLength(3, { message: 'name: custom' })
  name: string;

  @MinLength(8, { groups: ['admin'], message: i18nValidationMessage('orders.adminsOnly') })
  password: string;
}

/** A pipe of the app's own, which uses translateValidationErrors() for its own error shape. */
@Injectable()
class ProblemValidationPipe implements PipeTransform {
  async transform(value: unknown, { metatype }: ArgumentMetadata) {
    if (!metatype) {
      return value;
    }

    const object = plainToInstance(metatype, value) as object;
    const errors = translateValidationErrors(await validate(object));
    if (errors.length > 0) {
      throw new BadRequestException({
        title: 'Invalid request',
        errors: errors.map((error) => ({ field: error.property, detail: Object.values(error.constraints ?? {})[0] })),
      });
    }
    return object;
  }
}

@Controller()
class OrdersController {
  @Post('orders')
  create(@Body() dto: CreateOrderDto) {
    return { items: dto.items.length, first: dto.items[0] };
  }

  @Post('address')
  address(@Body() dto: ShippingAddressDto) {
    return dto;
  }

  @Post('tags')
  tags(@Body() dto: TagsDto) {
    return dto;
  }

  @Post('contact')
  contact(@Body() dto: ContactDto) {
    return dto;
  }

  @Post('search')
  search(@Query() query: SearchDto) {
    return query;
  }
}

@Controller('scoped')
class ScopedController {
  @Post('forms')
  @UsePipes(new I18nValidationPipe({ namespace: 'forms' }))
  forms(@Body() dto: ContactDto) {
    return dto;
  }

  @Post('grouped')
  @UsePipes(new I18nValidationPipe({ errorFormat: 'grouped' }))
  grouped(@Body() dto: ShippingAddressDto) {
    return dto;
  }

  @Post('factory')
  @UsePipes(
    new I18nValidationPipe({
      validationError: { target: false, value: false },
      exceptionFactory: (errors: ValidationError[]) =>
        new BadRequestException({
          errors: errors.map(({ property, constraints }) => ({ property, constraints })),
        }),
    }),
  )
  factory(@Body() dto: ShippingAddressDto) {
    return dto;
  }

  @Post('groups')
  @UsePipes(new I18nValidationPipe({ groups: ['admin'], always: true }))
  groups(@Body() dto: RoleDto) {
    return dto;
  }

  @Post('own-pipe')
  @UsePipes(ProblemValidationPipe)
  ownPipe(@Body() dto: ContactDto) {
    return dto;
  }
}

/** The tutorial's binding, one global validation pipe; or none, for the route-scoped pipes. */
function appModule(globalPipe: boolean, options: Partial<I18nForRootOptions> = {}) {
  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader(catalogs),
        resolvers: [new QueryLocaleResolver('lang'), new HeaderLocaleResolver('x-lang')],
        ...options,
      }),
    ],
    controllers: globalPipe ? [OrdersController] : [ScopedController],
    providers: globalPipe
      ? [{ provide: APP_PIPE, useValue: new I18nValidationPipe({ whitelist: true, transform: true }) }]
      : [],
  })
  class ClassValidatorAppModule {}

  return ClassValidatorAppModule;
}

describe.each(adapters)('class-validator messages over $name', ({ name }) => {
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

  it('bound with APP_PIPE: nested items, plural messages by count, explicit keys, no parent prefix', async () => {
    const body = { items: [{ productId: 1, quantity: 2 }, { productId: 'x', quantity: 12 }, { productId: 3, quantity: 0 }] };

    const pl = await post('/orders', body, 'pl').expect(400);
    expect(pl.body.message).toEqual([
      'items.1.productId musi być liczbą całkowitą',
      'items.1.quantity nie może przekraczać 10 sztuk na produkt',
      'items.2.quantity musi wynosić co najmniej 1',
    ]);
    expect(pl.headers['content-language']).toBe('pl');

    const en = await post('/orders', body).expect(400);
    expect(en.body.message[1]).toBe('items.1.quantity must not exceed 10 units per product');
  });

  it('keeps whitelist and transform working', async () => {
    const res = await post('/orders', { items: [{ productId: 1, quantity: 2, price: 0 }], admin: true }, 'pl').expect(201);

    expect(res.body).toEqual({ items: 1, first: { productId: 1, quantity: 2 } });
  });

  it('translates an empty array, and a plural minLength in every Polish form', async () => {
    expect((await post('/orders', { items: [] }, 'pl').expect(400)).body.message).toEqual([
      'items musi zawierać co najmniej jedną pozycję',
    ]);

    const address = await post('/address', { recipient: 'A', postalCode: 'abc', country: 'FR', city: 'X' }, 'pl').expect(400);
    expect(address.body.message).toEqual([
      'recipient musi mieć co najmniej 2 znaki',
      'postalCode ma niepoprawny format',
      'Wysyłamy tylko do Stanów Zjednoczonych, Polski i Niemiec.',
      'city: kept as the app wrote it',
    ]);
  });

  it('each: true uses the key of a single value', async () => {
    const res = await post('/tags', { tags: ['nest', 'js'] }, 'pl').expect(400);

    expect(res.body.message).toEqual(['tags musi mieć co najmniej 3 znaki']);
  });

  it('exposes {value}, and translates custom constraint classes by their name', async () => {
    const res = await post('/contact', { email: 'nope', lucky: 8 }, 'pl').expect(400);

    expect(res.body.message).toEqual([
      'email musi być adresem e-mail, a nie „nope”',
      'lucky musi być liczbą pierwszą, a nie 8',
    ]);
  });

  it('validates query DTOs too', async () => {
    const res = await request(app.getHttpServer()).post('/search?q=ab&lang=pl').expect(400);

    expect(res.body.message).toEqual(['q musi mieć co najmniej 3 znaki']);
  });

  it('a route-scoped pipe with its own namespace; constraints without a translation keep the library message', async () => {
    const res = await post('/scoped/forms', { email: 'nope', lucky: 8 }, 'pl').expect(400);

    expect(res.body.message).toEqual(['Podaj poprawny adres e-mail', 'lucky is not prime']);
  });

  it("errorFormat: 'grouped' groups translated messages by path", async () => {
    const res = await post('/scoped/grouped', { recipient: 'A', postalCode: '00-950', country: 'PL', city: 'Warszawa' }, 'pl').expect(400);

    expect(res.body.message).toEqual({ recipient: ['recipient musi mieć co najmniej 2 znaki'] });
  });

  it('a custom exceptionFactory receives translated constraints, without targets', async () => {
    const res = await post('/scoped/factory', { recipient: 'Ada', postalCode: 'x', country: 'FR', city: 'Kraków' }, 'pl').expect(400);

    expect(res.body).toEqual({
      errors: [
        { property: 'postalCode', constraints: { matches: 'postalCode ma niepoprawny format' } },
        { property: 'country', constraints: { isIn: 'Wysyłamy tylko do Stanów Zjednoczonych, Polski i Niemiec.' } },
      ],
    });
  });

  it('validation groups find the decorator of the constraint that failed', async () => {
    const res = await post('/scoped/groups', { name: 'A', password: 'short' }).expect(400);

    expect(res.body.message).toEqual(['name: custom', 'password needs at least 8 characters for admins']);
  });

  it("an app's own pipe localizes errors with translateValidationErrors()", async () => {
    const res = await post('/scoped/own-pipe', { email: 'a@b.co', lucky: 9 }, 'pl').expect(400);

    expect(res.body).toEqual({
      title: 'Invalid request',
      errors: [{ field: 'lucky', detail: 'lucky musi być liczbą pierwszą, a nie 9' }],
    });
  });
});

describe.each(adapters)("class-validator messages under missingKey: 'throw' over $name", ({ name }) => {
  let app: INestApplication;
  let error: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    app = await createApp(name, appModule(false, { missingKey: 'throw' }));
  });
  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('default messages without a translation keep the library text instead of failing', async () => {
    const res = await request(app.getHttpServer())
      .post('/scoped/forms')
      .set('x-lang', 'en')
      .send({ email: 'nope', lucky: 8 })
      .expect(400);

    expect(res.body.message).toEqual(['Please enter a valid email address', 'lucky is not prime']);
  });

  it('an explicit key missing in the locale fails the request, like t()', async () => {
    await request(app.getHttpServer())
      .post('/scoped/groups')
      .set('x-lang', 'pl')
      .send({ name: 'Ada', password: 'short' })
      .expect(500);

    expect(String(error.mock.calls.at(-1)?.[0])).toContain('Missing translation "orders.adminsOnly" for locale "pl"');
  });
});
