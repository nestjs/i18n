import { I18nMessageFormatter } from './i18n-message.formatter.js';

/**
 * The default formatter (internal): `{name}` placeholders, where a name is
 * letters, digits and `_`. A placeholder without an argument stays as
 * written, and `{{` and `}}` stand for literal braces.
 */
export class PlaceholderMessageFormatter extends I18nMessageFormatter {
  format(message: string, args: Record<string, unknown>): string {
    return message.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name: string | undefined) => {
      if (name === undefined) {
        return match[0];
      }
      return Object.hasOwn(args, name) ? toText(args[name]) : match;
    });
  }
}

/** `String(value)`, except that it never throws (a null-prototype object has no string form). */
function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
