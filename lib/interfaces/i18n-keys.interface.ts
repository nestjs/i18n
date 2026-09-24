import type {
  I18nTranslateOptions,
} from './i18n-translate-options.interface.js';

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** A leaf that selects a string by `Intl.PluralRules` category. */
export type I18nPluralForms = { other: string } & Partial<
  Record<Exclude<PluralCategory, 'other'>, string>
>;

type IsPlural<V> = V extends I18nPluralForms
  ? Exclude<keyof V, PluralCategory> extends never
    ? true
    : false
  : false;

/** Dot-separated paths to every translatable leaf of `T`. */
export type I18nPath<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : IsPlural<T[K]> extends true
      ? K
      : T[K] extends object
        ? `${K}.${I18nPath<T[K]>}`
        : never;
}[keyof T & string];

/** Paths to the messages of `T` that have plural forms. */
export type I18nPluralPath<T> = {
  [K in keyof T & string]: IsPlural<T[K]> extends true
    ? K
    : T[K] extends string
      ? never
      : T[K] extends object
        ? `${K}.${I18nPluralPath<T[K]>}`
        : never;
}[keyof T & string];

/**
 * Register the catalog shape once to type-check keys everywhere: in
 * `I18nService`, `t()`, `i18nValidationMessage()` and `i18nIssueMessage()`.
 *
 * ```ts
 * declare module '@nestjs/i18n' {
 *   interface I18nTypes {
 *     translations: Translations;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface I18nTypes {}

/** The registered catalog shape, or `unknown` (any string key) when none is. */
export type I18nRegisteredTranslations = I18nTypes extends {
  translations: infer T;
}
  ? T
  : unknown;

/**
 * A key of the catalog shape `T` (the registered one by default), or any
 * string when there's no shape. Plural messages are keys; their forms aren't.
 */
export type I18nKey<T = I18nRegisteredTranslations> = unknown extends T
  ? string
  : I18nPath<T>;

/**
 * The options argument of `t()` for key `K`. A plural message needs a
 * numeric `count` to pick its form, so for those keys it's required.
 */
export type I18nTranslateArgs<T, K> = unknown extends T
  ? [options?: I18nTranslateOptions]
  : [K] extends [I18nPluralPath<T>]
    ? [options: I18nTranslateOptions & { args: { count: number } }]
    : [options?: I18nTranslateOptions];
