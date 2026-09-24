import {
  AcceptLanguageLocaleResolver,
  I18nModule,
  i18nIssueMessage,
  i18nValidationMessage,
  JsonI18nLoader,
  QueryLocaleResolver,
  t,
  type I18nKey,
  type I18nModuleOptions,
  type I18nService,
} from '../lib/index.js';
import type { AppTranslations } from './app.js';

// Type-level assertions; `tsc --noEmit` fails if any @ts-expect-error is unused.
type Keys = I18nKey<AppTranslations>;

describe('typed keys', () => {
  it('accepts leaf and plural keys, rejects unknown ones', () => {
    const check = (i18n: I18nService<AppTranslations>) => {
      i18n.t('users.notFound');
      i18n.t('users.apples', { args: { count: 2 } });
      i18n.t('validation.isEmail');
      // @ts-expect-error unknown key
      i18n.t('users.nope');
      // @ts-expect-error namespaces are not leaves
      i18n.t('users');
      // @ts-expect-error plural forms are not addressable on their own
      i18n.t('users.apples.one');
      // @ts-expect-error a plural message needs a count
      i18n.t('users.apples');
      // @ts-expect-error a plural message needs a numeric count
      i18n.t('users.apples', { args: { count: '2' } });
      // untyped escape hatch for runtime-built keys
      i18n.translate(`users.${'nope'}`);
    };
    const untyped = (i18n: I18nService) => {
      i18n.t('anything.goes');
      i18n.t('anything.goes', { locale: 'pl', args: { any: 1 } });
    };

    const helpers = () => {
      t<AppTranslations>('users.notFound', { args: { id: 1 } });
      i18nValidationMessage<AppTranslations>('users.tooYoung');
      i18nIssueMessage<AppTranslations>('users.tooYoung', { constraint1: 18 });
      // @ts-expect-error typo in a helper key
      t<AppTranslations>('users.notFund');
      // @ts-expect-error typo in a helper key
      i18nValidationMessage<AppTranslations>('users.tooYung');
      // @ts-expect-error typo in a helper key
      i18nIssueMessage<AppTranslations>('users.tooYung');
      // without a registered catalog, helpers accept any string
      t('anything.goes');
    };
    // the loader's options are readable (e.g. to assert `watch` in tests)
    const watch: boolean | undefined = new JsonI18nLoader({ path: '.' }).options.watch;

    const keys: Keys[] = ['users.greeting', 'users.apples'];
    // without a registered catalog, `I18nKey` is any string
    const anyKey: I18nKey = 'anything.goes';
    expect(typeof helpers).toBe('function');
    expect(watch).toBeUndefined();
    expect(keys).toHaveLength(2);
    expect(anyKey).toBe('anything.goes');
    expect(typeof check).toBe('function');
    expect(typeof untyped).toBe('function');
  });
});

describe('module options', () => {
  it('takes classes at the top level, and only instances from the factory', () => {
    const registrations = () => [
      // classes and imports at the top level of forRoot()
      I18nModule.forRoot({
        imports: [],
        loader: JsonI18nLoader,
        resolvers: [QueryLocaleResolver, new AcceptLanguageLocaleResolver()],
      }),
      // @ts-expect-error forRoot() requires a loader
      I18nModule.forRoot({ defaultLocale: 'en' }),
      // instances from the factory, classes next to it
      I18nModule.forRootAsync({
        imports: [],
        useFactory: (): I18nModuleOptions => ({
          loader: new JsonI18nLoader({ path: '.' }),
          defaultLocale: 'en',
        }),
        resolvers: [QueryLocaleResolver],
      }),
      I18nModule.forRootAsync({
        // @ts-expect-error the factory returns instances; classes go at the top level
        useFactory: () => ({ loader: JsonI18nLoader }),
      }),
      I18nModule.forRootAsync({
        // @ts-expect-error the factory returns instances; classes go at the top level
        useFactory: () => ({ resolvers: [QueryLocaleResolver] }),
      }),
    ];
    expect(typeof registrations).toBe('function');
  });
});
