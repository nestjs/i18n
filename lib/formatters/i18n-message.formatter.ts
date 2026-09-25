/**
 * Turns a message into text. The default fills `{name}` placeholders; extend
 * this class to read another syntax, such as ICU MessageFormat, and pass an
 * instance, or a class Nest instantiates, in the `formatter` option.
 */
export abstract class I18nMessageFormatter {
  /**
   * Called for every translation, after a plural form has been picked for a
   * numeric `args.count`, so cache what you compile per locale and message.
   * `locale` is the one the message is formatted for: the requested locale
   * (`de-AT` for a message from the `de` catalog through `fallbacks`), or
   * the default locale's when the message fell back to it. What it throws
   * reaches the caller of `t()`.
   */
  abstract format(message: string, args: Record<string, unknown>, locale: string): string;
}
