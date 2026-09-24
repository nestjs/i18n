import type { StandardSchemaV1 } from '@standard-schema/spec';
import { i18nStorage } from '../context/i18n.storage.js';
import type {
  I18nKey,
  I18nRegisteredTranslations,
} from '../interfaces/i18n-keys.interface.js';
import type {
  TranslateIssuesOptions,
} from '../interfaces/validation-options.interface.js';

const PREFIX = '$i18n:';

/**
 * A schema message that names a translation key, for any Standard Schema
 * library (messages there are plain strings):
 * `z.number().min(18, i18nIssueMessage('users.tooYoung', { min: 18 }))`.
 */
export function i18nIssueMessage<T = I18nRegisteredTranslations>(
  key: I18nKey<NoInfer<T>>,
  args?: Record<string, unknown>,
): string {
  return args ? `${PREFIX}${key}|${JSON.stringify(args)}` : `${PREFIX}${key}`;
}

/** Issue fields exposed for interpolation when present (some are getters). */
const KNOWN_PARAMS = [
  'code', 'type', 'kind', 'format', 'origin', 'expected', 'received',
  'actual', 'minimum', 'maximum', 'inclusive', 'requirement', 'rule',
  'validation', 'input',
];

const translatedIssues = new WeakSet<object>();

/** True for issues produced by `translateStandardSchemaIssues`. */
export function isTranslatedIssue(issue: StandardSchemaV1.Issue): boolean {
  return translatedIssues.has(issue);
}

/** The built-in candidate keys: `<code>.<format>`, `<code>.<origin>`, `<code>`. */
export function defaultIssueKeys(issue: StandardSchemaV1.Issue): string[] {
  const any = issue as unknown as Record<string, unknown>;
  const code = typeof any.code === 'string' ? any.code
    : typeof any.type === 'string' ? any.type : undefined;
  if (!code) {
    return [];
  }

  const keys: string[] = [];
  if (typeof any.format === 'string') {
    keys.push(`${code}.${any.format}`);
  }
  if (typeof any.origin === 'string') {
    keys.push(`${code}.${any.origin}`);
  }
  keys.push(code);
  return keys;
}

function issuePath(issue: StandardSchemaV1.Issue): string[] {
  return (Array.isArray(issue.path) ? issue.path : []).map((segment) =>
    String(typeof segment === 'object' && segment !== null ? segment.key : segment),
  );
}

/**
 * The key and args of a message made by `i18nIssueMessage()`, `null` for a
 * message that only looks like one, `undefined` for any other message.
 */
function explicitKey(
  message: unknown,
): { key: string; args?: Record<string, unknown> } | null | undefined {
  if (typeof message !== 'string' || !message.startsWith(PREFIX)) {
    return undefined;
  }

  const body = message.slice(PREFIX.length);
  const bar = body.indexOf('|');
  const key = bar === -1 ? body : body.slice(0, bar);
  if (!key) {
    return null;
  }
  if (bar === -1) {
    return { key };
  }

  try {
    const args: unknown = JSON.parse(body.slice(bar + 1));
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      return { key, args: args as Record<string, unknown> };
    }
  } catch {
    // not made by i18nIssueMessage(): keep the issue as it is
  }
  return null;
}

/**
 * Returns new issues with messages translated for the current locale, for
 * pipes of your own: explicit `i18nIssueMessage()` keys first, then
 * issue-code keys (`validation.too_small`) when they exist, for issues that have a path;
 * anything else (including an issue about the whole input) is returned as is. Translated issues keep every other field of the original.
 * Interpolation args: `{path}`, `{property}` (last path segment), `{message}`
 * (the library's own message), the issue's primitive params (`{minimum}`,
 * `{expected}`, `{requirement}`, ...) and `{count}` (the numeric `minimum`,
 * `maximum` or `requirement`), which selects plural forms.
 */
export function translateStandardSchemaIssues(
  issues: readonly StandardSchemaV1.Issue[],
  options: TranslateIssuesOptions = {},
): StandardSchemaV1.Issue[] {
  const store = i18nStorage.getStore();
  if (!store) {
    return [...issues];
  }
  const namespace = options.namespace ?? 'validation';

  return issues.map((issue) => {
    const explicit = explicitKey(issue.message);
    if (explicit === null) {
      return issue;
    }

    let args = issueArgs(issue);
    let key: string | undefined;
    if (explicit) {
      key = explicit.key;
      args = { ...args, ...explicit.args };
    } else {
      // Issue-code messages are written for a field (`{path} must be ...`). An issue about the
      // whole input (a body that isn't an object) has no path, so it keeps the library's message.
      if (issuePath(issue).length === 0) {
        return issue;
      }
      const candidates = [...(options.issueKeys?.(issue) ?? []), ...defaultIssueKeys(issue)];
      key = candidates
        .map((k) => `${namespace}.${k}`)
        .find((k) => store.service.exists(k, store.locale));
    }

    if (!key) {
      return issue;
    }
    return withMessage(issue, store.service.translate(key, { locale: store.locale, args }));
  });
}

/**
 * A copy of `issue` with a new message. Plain issues (Zod, Valibot) are
 * copied field by field; class-based ones (ArkType) are extended, so the
 * getters on their prototype keep working.
 */
function withMessage(issue: StandardSchemaV1.Issue, message: string): StandardSchemaV1.Issue {
  const prototype = Object.getPrototypeOf(issue);
  const translated: StandardSchemaV1.Issue =
    prototype === Object.prototype || prototype === null
      ? { ...issue, message }
      : Object.create(issue, {
          message: { value: message, enumerable: true },
          path: { value: issue.path, enumerable: true },
        });

  translatedIssues.add(translated);
  return translated;
}

function issueArgs(issue: StandardSchemaV1.Issue): Record<string, unknown> {
  const any = issue as unknown as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const isPrimitive = (v: unknown) =>
    ['string', 'number', 'boolean', 'bigint'].includes(typeof v);

  for (const name of [...Object.keys(any), ...KNOWN_PARAMS]) {
    if (name === 'message' || name === 'path') {
      continue;
    }
    let value: unknown;
    try {
      value = any[name];
    } catch {
      continue; // a getter that throws is no param
    }
    if (isPrimitive(value)) {
      args[name] = value;
    }
  }

  const path = issuePath(issue);
  args.path = path.join('.');
  args.property = path[path.length - 1] ?? '';
  args.message = issue.message;

  const count = [any.minimum, any.maximum, any.requirement].find(
    (v) => typeof v === 'number' || typeof v === 'bigint',
  );
  if (count !== undefined && args.count === undefined) {
    args.count = Number(count);
  }
  return args;
}
