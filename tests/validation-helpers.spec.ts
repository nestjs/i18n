import { BadRequestException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Type } from 'class-transformer';
import {
  IsEmail,
  Max,
  MinLength,
  Validate,
  ValidateNested,
  validate,
  ValidatorConstraint,
  type ValidationError,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  I18nContext,
  I18nModule,
  I18nStandardSchemaValidationPipe,
  i18nIssueMessage,
  i18nValidationMessage,
  I18nValidationPipe,
  InMemoryI18nLoader,
  translateStandardSchemaIssues,
  translateValidationErrors,
} from '../lib/index.js';
import { isTranslatedIssue } from '../lib/validation/standard-schema-messages.js';

const catalogs = {
  en: {
    validation: {
      isEmail: '{path} must be an email',
      isPrime: '{property} must be a prime number, got {value}',
      too_small: 'at least {minimum}',
      custom: 'custom issue at {path}',
    },
    errors: {
      isEmail: '{property}: not an email',
      too_small: '{path}: too small',
    },
    messages: {
      max: '{property} ≤ {constraint1} (count {count}, value {value})',
      labelled: '{label} is too long',
      issue: '{property} at {path}: {code}/{minimum}/{count}/{message}',
    },
  },
  pl: {
    validation: { isEmail: '{path} musi być adresem e-mail' },
    messages: { max: '{property} ≤ {constraint1}' },
  },
};

let context: I18nContext;

beforeAll(async () => {
  const ref = await Test.createTestingModule({
    imports: [I18nModule.forRoot({ loader: new InMemoryI18nLoader(catalogs) })],
  }).compile();
  context = ref.get(I18nContext);
});

describe('i18nValidationMessage()', () => {
  class OrderDto {
    @Max(10, { message: i18nValidationMessage('messages.max') })
    copies: number;

    @MinLength(3, { message: i18nValidationMessage('messages.labelled', { label: 'Title' }) })
    title: string;
  }

  const order = () => Object.assign(new OrderDto(), { copies: 12, title: 'ab' });
  const messagesOf = (errors: ValidationError[]) => errors.flatMap((e) => Object.values(e.constraints ?? {}));

  it('translates when class-validator renders it, with the property, value, constraints and count', async () => {
    expect(messagesOf(await context.run('en', () => validate(order())))).toEqual([
      'copies ≤ 10 (count 10, value 12)',
      'Title is too long',
    ]);
    expect(messagesOf(await context.run('pl', () => validate(order())))[0]).toBe('copies ≤ 10');
  });

  it('returns the key outside a request', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      expect(messagesOf(await validate(order()))).toEqual(['messages.max', 'messages.labelled']);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('class-validator messages', () => {
  @ValidatorConstraint({ name: 'isPrime' })
  class IsPrime implements ValidatorConstraintInterface {
    validate(value: number) {
      return value > 1 && [...Array(value).keys()].slice(2).every((d) => value % d !== 0);
    }

    defaultMessage() {
      return '$property is not prime';
    }
  }

  class AddressDto {
    @IsEmail()
    contact: string;
  }

  class CustomerDto {
    @Validate(IsPrime)
    lucky: number;

    @IsEmail()
    email: string;

    @ValidateNested()
    @Type(() => AddressDto)
    address: AddressDto;
  }

  const invalid = { lucky: 8, email: 'nope', address: { contact: 'nope' } };

  const reject = (pipe: I18nValidationPipe, locale = 'en') =>
    context.run(locale, () =>
      pipe.transform(invalid, { type: 'body', metatype: CustomerDto }).then(
        () => {
          throw new Error('expected a validation error');
        },
        (e: BadRequestException) => e.getResponse() as { message: unknown },
      ),
    );

  it('translates constraints of custom validator classes by their name', async () => {
    const { message } = await reject(new I18nValidationPipe());
    expect(message).toEqual([
      'lucky must be a prime number, got 8',
      'email must be an email',
      'address.contact must be an email',
    ]);
  });

  it('reads default messages from another namespace', async () => {
    const { message } = await reject(new I18nValidationPipe({ namespace: 'errors' }));
    expect(message).toEqual([
      'lucky is not prime',
      'email: not an email',
      'contact: not an email',
    ]);
  });

  it('removes targets from nested errors when validationError.target is false', async () => {
    const pipe = new I18nValidationPipe({
      validationError: { target: false },
      exceptionFactory: (errors) => new BadRequestException({ message: errors }),
    });
    const { message } = await reject(pipe, 'pl');
    const [, email, address] = message as ValidationError[];
    expect(email.constraints).toEqual({ isEmail: 'email musi być adresem e-mail' });
    expect(address.children![0].constraints).toEqual({ isEmail: 'address.contact musi być adresem e-mail' });
    expect(address).not.toHaveProperty('target');
    expect(address.children![0]).not.toHaveProperty('target');
  });

  it('translateValidationErrors() returns the errors untouched outside a request', async () => {
    const errors = await validate(Object.assign(new CustomerDto(), { lucky: 8, email: 'x', address: new AddressDto() }));
    const before = structuredClone(errors.map((e) => e.constraints));
    expect(translateValidationErrors(errors)).toBe(errors);
    expect(errors.map((e) => e.constraints)).toEqual(before);
  });

  it('translateValidationErrors() rewrites errors in place in a request, with a namespace', async () => {
    const errors = await validate(Object.assign(new CustomerDto(), { lucky: 7, email: 'x', address: new AddressDto() }));
    const result = context.run('en', () => translateValidationErrors(errors, { namespace: 'errors' }));
    expect(result).toBe(errors);
    expect(errors.find((e) => e.property === 'email')!.constraints).toEqual({ isEmail: 'email: not an email' });
  });
});

describe('Standard Schema messages', () => {
  it('i18nIssueMessage() encodes the key and its arguments in the message string', () => {
    expect(i18nIssueMessage('users.tooYoung')).toBe('$i18n:users.tooYoung');
    expect(i18nIssueMessage('users.tooYoung', { min: 18 })).toBe('$i18n:users.tooYoung|{"min":18}');
  });

  it('translateStandardSchemaIssues() returns a copy of the issues outside a request', () => {
    const issues = [{ message: i18nIssueMessage('messages.max'), path: ['x'] }];
    const result = translateStandardSchemaIssues(issues);
    expect(result).not.toBe(issues);
    expect(result).toEqual(issues);
  });

  const translate = (issues: object[], options?: Parameters<typeof translateStandardSchemaIssues>[1]) =>
    context.run('en', () => translateStandardSchemaIssues(issues as StandardSchemaV1.Issue[], options));

  it('translates an explicit key even for an issue about the whole input', () => {
    expect(translate([{ message: i18nIssueMessage('messages.labelled', { label: 'Body' }) }])[0].message).toBe(
      'Body is too long',
    );
  });

  it('exposes the path, the last segment, the issue fields and the library message; explicit args win', () => {
    const [issue] = translate([
      {
        code: 'too_small',
        minimum: 5n,
        path: ['lines', 1, { key: 'qty' }],
        message: i18nIssueMessage('messages.issue', { code: 'overridden' }),
      },
    ]);
    expect(issue.message).toBe(`qty at lines.1.qty: overridden/5/5/${i18nIssueMessage('messages.issue', { code: 'overridden' })}`);
  });

  it('skips issue fields whose getters throw', () => {
    class Issue {
      readonly path = ['age'];
      readonly message = 'Too small';
      readonly minimum = 3;
      get code() {
        return 'too_small';
      }
      get expected(): string {
        throw new Error('not computed');
      }
    }
    expect(translate([new Issue()])[0].message).toBe('at least 3');
  });

  it('skips a count getter that throws', () => {
    class Issue {
      readonly path = ['age'];
      readonly message = 'Too small';
      get code() {
        return 'too_small';
      }
      get minimum(): number {
        throw new Error('not computed');
      }
    }
    expect(translate([new Issue()])[0].message).toBe('at least {minimum}');
  });

  it('falls back to the bare code key, and marks only the issues it translated', () => {
    const [translated, untouched] = translate([
      { code: 'too_small', origin: 'array', minimum: 2, path: ['tags'], message: 'Too small' },
      { code: 'unknown_code', path: ['tags'], message: 'Library message' },
    ]);
    expect(translated.message).toBe('at least 2');
    expect(isTranslatedIssue(translated)).toBe(true);
    expect(untouched.message).toBe('Library message');
    expect(isTranslatedIssue(untouched)).toBe(false);
  });

  it('keeps messages that are malformed explicit keys', () => {
    for (const message of ['$i18n:', '$i18n:|{}', '$i18n:messages.max|null', '$i18n:messages.max|"x"']) {
      expect(translate([{ message, path: ['x'] }])[0].message).toBe(message);
    }
  });

  it('reads issue-code keys from another namespace, and issueKeys from it too', () => {
    const issues = [{ code: 'too_small', minimum: 1, path: ['name'], message: 'Too small' }];
    expect(translate(issues, { namespace: 'errors' })[0].message).toBe('name: too small');
    expect(translate(issues, { namespace: 'messages', issueKeys: () => ['labelled'] })[0].message).toBe(
      '{label} is too long',
    );
  });

  it('I18nStandardSchemaValidationPipe takes a namespace', async () => {
    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({
          issues: [
            { code: 'too_small', path: ['name'], message: 'Too small' },
            { code: 'custom', path: ['coupon'], message: 'Coupon expired' },
          ] as unknown as StandardSchemaV1.Issue[],
        }),
      },
    };
    const message = await context.run('en', () =>
      new I18nStandardSchemaValidationPipe({ namespace: 'errors' })
        .transform({}, { type: 'body', schema } as never)
        .then(
          () => undefined,
          (e: BadRequestException) => (e.getResponse() as { message: unknown }).message,
        ),
    );
    expect(message).toEqual(['name: too small', 'coupon: Coupon expired']);
  });
});
