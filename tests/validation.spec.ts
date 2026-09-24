import { BadRequestException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, Max, MinLength, ValidateNested } from 'class-validator';
import {
  I18nContext,
  I18nMissingKeyError,
  I18nModule,
  I18nStandardSchemaValidationPipe,
  i18nValidationMessage,
  I18nValidationPipe,
  InMemoryI18nLoader,
  translateValidationErrors,
} from '../lib/index.js';
import { defaultIssueKeys } from '../lib/validation/standard-schema-messages.js';

const plural = (one: string, few: string, many: string) => ({
  one,
  few,
  many,
  other: few,
});

const resources = {
  en: {
    validation: {
      minLength: { one: '{path}: at least {count} character', other: '{path}: at least {count} characters' },
      too_small: {
        string: { one: '{property}: at least {count} character', other: '{property}: at least {count} characters' },
        number: '{property} must be {minimum} or more',
      },
    },
    items: { tooMany: '{path}: at most {count} per item' },
  },
  pl: {
    validation: {
      minLength: plural(
        '{path}: co najmniej {count} znak',
        '{path}: co najmniej {count} znaki',
        '{path}: co najmniej {count} znaków',
      ),
      too_small: {
        string: plural(
          '{property}: co najmniej {count} znak',
          '{property}: co najmniej {count} znaki',
          '{property}: co najmniej {count} znaków',
        ),
        number: '{property} musi wynosić co najmniej {minimum}',
      },
    },
    items: {
      tooMany: plural(
        '{path}: najwyżej {count} sztuka',
        '{path}: najwyżej {count} sztuki',
        '{path}: najwyżej {count} sztuk',
      ),
    },
  },
};

class LineDto {
  @MinLength(2)
  code: string;

  @Max(5, { message: i18nValidationMessage('items.tooMany') })
  quantity: number;

  @MinLength(1, { message: 'plain custom message' })
  note: string;
}

class CartDto {
  @MinLength(5)
  owner: string;

  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines: LineDto[];
}

describe('validation messages', () => {
  let context: I18nContext;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({ defaultLocale: 'en', loader: new InMemoryI18nLoader(resources) }),
      ],
    }).compile();
    context = ref.get(I18nContext);
  });

  const invalidCart = {
    owner: 'Ann',
    lines: [
      { code: 'ok', quantity: 1, note: 'x' },
      { code: 'A', quantity: 22, note: '' },
    ],
  };

  const validate = (pipe: I18nValidationPipe, locale: string) =>
    context.run(locale, () =>
      pipe
        .transform(invalidCart, { type: 'body', metatype: CartDto })
        .then(() => undefined, (e: BadRequestException) => e.getResponse()),
    );

  it('selects plural forms by the first numeric constraint and does not prefix translated nested messages', async () => {
    const res = (await validate(new I18nValidationPipe({ transform: true }), 'pl')) as {
      message: string[];
    };
    expect(res.message).toEqual([
      'owner: co najmniej 5 znaków',
      'lines.1.code: co najmniej 2 znaki',
      'lines.1.quantity: najwyżej 5 sztuk',
      'lines.1.plain custom message',
    ]);
  });

  it('English plural forms and the grouped format', async () => {
    const res = (await validate(
      new I18nValidationPipe({ transform: true, errorFormat: 'grouped' }),
      'en',
    )) as { message: Record<string, string[]> };
    expect(res.message).toEqual({
      owner: ['owner: at least 5 characters'],
      'lines.1.code': ['lines.1.code: at least 2 characters'],
      'lines.1.quantity': ['lines.1.quantity: at most 5 per item'],
      'lines.1.note': ['plain custom message'],
    });
  });

  describe('Standard Schema issues', () => {
    const tooSmall = (origin: string, minimum: number, path: string) =>
      ({ code: 'too_small', origin, minimum, inclusive: true, path: [path], message: 'Too small' }) as StandardSchemaV1.Issue;

    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({
          issues: [tooSmall('string', 1, 'city'), tooSmall('string', 5, 'street'), tooSmall('number', 18, 'age')],
        }),
      },
    };

    it('looks up <code>.<origin> and exposes the minimum as count', async () => {
      const pipe = new I18nStandardSchemaValidationPipe();
      const message = await context.run('pl', () =>
        pipe
          .transform({}, { type: 'body', schema } as any)
          .then(() => undefined, (e: BadRequestException) => (e.getResponse() as any).message),
      );
      expect(message).toEqual([
        'city: co najmniej 1 znak',
        'street: co najmniej 5 znaków',
        'age musi wynosić co najmniej 18',
      ]);
    });

    it('default issue keys: format, origin, code', () => {
      expect(
        defaultIssueKeys({ code: 'invalid_format', format: 'regex', origin: 'string', message: '' } as any),
      ).toEqual(['invalid_format.regex', 'invalid_format.string', 'invalid_format']);
      expect(defaultIssueKeys({ type: 'min_value', message: '' } as any)).toEqual(['min_value']);
    });

    it('tries issueKeys before the built-in keys', async () => {
      // Zod 3 reports the origin as `type`; the built-in keys only know Zod 4's `origin`.
      const zod3: StandardSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => ({
            issues: [
              { code: 'too_small', type: 'string', minimum: 5, path: ['street'], message: 'Too small' },
              tooSmall('number', 18, 'age'),
            ] as StandardSchemaV1.Issue[],
          }),
        },
      };
      const pipe = new I18nStandardSchemaValidationPipe({
        issueKeys: (issue) => {
          const { code, type } = issue as { code?: string; type?: string };
          return code && type ? [`${code}.${type}`] : [];
        },
      });
      const message = await context.run('pl', () =>
        pipe
          .transform({}, { type: 'body', schema: zod3 } as any)
          .then(() => undefined, (e: BadRequestException) => (e.getResponse() as any).message),
      );
      expect(message).toEqual(['street: co najmniej 5 znaków', 'age musi wynosić co najmniej 18']);
    });
  });

  it('picks the "other" form of a plural message when the constraint has no number', async () => {
    class NoteDto {
      @IsNotEmpty()
      note: string;
    }
    const ref = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          missingKey: 'throw',
          loader: new InMemoryI18nLoader({
            en: { validation: { isNotEmpty: { one: '{path}: one', other: '{path} must not be empty' } } },
          }),
        }),
      ],
    }).compile();
    const response = await ref.get(I18nContext).run('en', () =>
      new I18nValidationPipe()
        .transform({ note: '' }, { type: 'body', metatype: NoteDto })
        .then(() => undefined, (e: BadRequestException) => e.getResponse()),
    );
    expect(response).toMatchObject({ message: ['note must not be empty'] });
  });

  it('plural validation messages do not warn about missing keys', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      await validate(new I18nValidationPipe({ transform: true }), 'pl');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('validation messages: arguments, groups and malformed input', () => {
  let context: I18nContext;

  const catalogs = {
    en: {
      validation: {
        isEmail: '{property} must be an email, got {value}',
        isIn: '{property} must be one of: {constraint1}',
        minLength: 'default minLength message',
        too_small: 'too small: {minimum}',
      },
      orders: { tooMany: 'at most {count}', onlyEnglish: 'English only' },
    },
    pl: { validation: {}, orders: { tooMany: 'najwyżej {count}' } },
  };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [I18nModule.forRoot({ loader: new InMemoryI18nLoader(catalogs), missingKey: 'throw' })],
    }).compile();
    context = ref.get(I18nContext);
  });

  const messages = (pipe: I18nValidationPipe, metatype: new () => object, body: object, locale = 'en') =>
    context.run(locale, () =>
      pipe.transform(body, { type: 'body', metatype }).then(
        () => [],
        (e: unknown) => {
          if (!(e instanceof BadRequestException)) {
            throw e;
          }
          return (e.getResponse() as { message: string[] }).message;
        },
      ),
    );

  it('{value} is the rejected value when it is a string, number or boolean, like $value', async () => {
    class ContactDto {
      @IsEmail()
      email: unknown;
    }
    expect(await messages(new I18nValidationPipe(), ContactDto, { email: 'nope' })).toEqual([
      'email must be an email, got nope',
    ]);
    expect(await messages(new I18nValidationPipe(), ContactDto, { email: { $gt: '' } })).toEqual([
      'email must be an email, got {value}',
    ]);
  });

  it('{constraintN} formats an array constraint as class-validator does', async () => {
    class AddressDto {
      @IsIn(['US', 'PL', 'DE'])
      country: string;
    }
    expect(await messages(new I18nValidationPipe(), AddressDto, { country: 'FR' })).toEqual([
      'country must be one of: US, PL, DE',
    ]);
  });

  it('finds the decorator of a constraint validated with groups and always', async () => {
    class SignupDto {
      @MinLength(3, { message: 'custom, kept as is' })
      name: string;

      @MinLength(3, { groups: ['admin'], message: i18nValidationMessage('orders.tooMany') })
      role: string;
    }
    const pipe = new I18nValidationPipe({ groups: ['admin'], always: true });
    expect(await messages(pipe, SignupDto, { name: 'A', role: 'x' })).toEqual([
      'custom, kept as is',
      'at most 3',
    ]);
  });

  it('keeps custom messages and explicit keys with validationError.target: false', async () => {
    class SignupDto {
      @MinLength(3, { message: 'custom, kept as is' })
      name: string;

      @Max(5, { message: i18nValidationMessage('orders.tooMany') })
      quantity: number;

      @IsIn(['a'])
      kind: string;
    }
    const pipe = new I18nValidationPipe({
      validationError: { target: false },
      exceptionFactory: (errors) => new BadRequestException({ message: errors }),
    });
    const errors = (await messages(pipe, SignupDto, { name: 'A', quantity: 9, kind: 'b' })) as unknown as {
      constraints: Record<string, string>;
    }[];
    expect(errors.map((error) => error.constraints)).toEqual([
      { minLength: 'custom, kept as is' },
      { max: 'at most 5' },
      { isIn: 'kind must be one of: a' },
    ]);
    // the target stays out of the errors, as configured
    expect(errors.some((error) => 'target' in error)).toBe(false);
    // errors without a target can't be matched to their decorators: left as they are
    const bare = [{ property: 'name', constraints: { minLength: 'custom, kept as is' }, children: [] }];
    expect(context.run('en', () => translateValidationErrors(bare))[0].constraints).toEqual({
      minLength: 'custom, kept as is',
    });
  });

  it('under the throw policy, explicit keys throw like t(); default keys never do', async () => {
    class LineDto {
      @Max(5, { message: i18nValidationMessage('orders.onlyEnglish') })
      quantity: number;

      @IsIn(['a'])
      kind: string;
    }
    // validation.isIn is missing in pl: the class-validator message stays
    expect(await messages(new I18nValidationPipe(), LineDto, { quantity: 1, kind: 'b' }, 'pl')).toEqual([
      'kind must be one of the following values: a',
    ]);
    await expect(
      messages(new I18nValidationPipe(), LineDto, { quantity: 9, kind: 'a' }, 'pl'),
    ).rejects.toThrow(new I18nMissingKeyError('orders.onlyEnglish', 'pl'));
  });

  describe('Standard Schema', () => {
    const schema = (issues: object[]): StandardSchemaV1 => ({
      '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: issues as StandardSchemaV1.Issue[] }) },
    });
    const run = (issues: object[], pipe = new I18nStandardSchemaValidationPipe()) =>
      context.run('en', () =>
        pipe.transform({}, { type: 'body', schema: schema(issues) } as never).then(
          () => undefined,
          (e: BadRequestException) => (e.getResponse() as { message: unknown }).message,
        ),
      );

    it('keeps an issue whose message only looks like an explicit key', async () => {
      expect(await run([{ message: '$i18n:orders.tooMany|{broken', path: ['quantity'] }])).toEqual([
        'quantity: $i18n:orders.tooMany|{broken',
      ]);
      expect(await run([{ message: '$i18n:orders.tooMany|[1]', path: ['quantity'] }])).toEqual([
        'quantity: $i18n:orders.tooMany|[1]',
      ]);
    });

    it('keeps the library message for an issue about the whole input, which has no field to name', async () => {
      // The catalog's too_small.string is written for a field; a root issue would render with an empty path.
      expect(await run([{ code: 'too_small', minimum: 2, origin: 'string', message: 'Too small' }])).toEqual(['Too small']);
      expect(await run([{ code: 'too_small', minimum: 2, origin: 'string', path: [], message: 'Too small' }])).toEqual([
        'Too small',
      ]);
    });

    it('keeps an issue without a string message instead of failing', async () => {
      expect(await run([{ path: ['quantity'], code: 'custom' }])).toEqual(['quantity: undefined']);
    });

    it('keeps the fields of translated issues for a custom exceptionFactory', async () => {
      const pipe = new I18nStandardSchemaValidationPipe({
        exceptionFactory: (issues) => new BadRequestException(issues),
      });
      expect(
        await run([{ code: 'too_small', minimum: 2, origin: 'string', path: ['city'], message: 'Too small' }], pipe),
      ).toEqual([{ code: 'too_small', minimum: 2, origin: 'string', path: ['city'], message: 'too small: 2' }]);
    });

    it('keeps the getters of class-based issues (ArkType)', async () => {
      class Issue {
        readonly path = ['age'];
        get code() {
          return 'too_small';
        }
        get minimum() {
          return 18;
        }
        get message() {
          return 'must be at least 18';
        }
      }
      let received: StandardSchemaV1.Issue[] = [];
      const pipe = new I18nStandardSchemaValidationPipe({
        exceptionFactory: (issues) => {
          received = [...issues];
          return new BadRequestException();
        },
      });
      await run([new Issue()], pipe);
      expect(received[0]).toMatchObject({ code: 'too_small', minimum: 18, message: 'too small: 18' });
      expect(received[0].path).toEqual(['age']);
    });
  });
});
