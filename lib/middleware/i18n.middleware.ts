import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { i18nStorage } from '../context/i18n.storage.js';
import { I18N_MODULE_OPTIONS } from '../i18n.constants.js';
import { I18nService } from '../i18n.service.js';
import type {
  I18nModuleOptions,
} from '../interfaces/i18n-module-options.interface.js';
import { LocaleResolution } from '../services/locale-resolution.service.js';
import { queryOf } from '../utils/request.util.js';

interface ResponseLike {
  getHeader?(name: string): unknown;
  setHeader?(name: string, value: string): unknown;
  writeHead?(...args: unknown[]): unknown;
}

/**
 * Resolves the request locale and runs the rest of the request pipeline
 * (guards, interceptors, pipes, handler, exception filters) inside the
 * locale context. Receives the raw request on both Express and Fastify
 * (via @fastify/middie), so query parsing is done here. Also sets
 * `Content-Language` and `Vary` unless `responseHeaders: false` (internal).
 */
@Injectable()
export class I18nMiddleware implements NestMiddleware {
  constructor(
    private readonly resolution: LocaleResolution,
    private readonly i18n: I18nService,
    @Inject(I18N_MODULE_OPTIONS) private readonly options: I18nModuleOptions,
  ) {}

  async use(
    req: { headers: Record<string, any>; url?: string; originalUrl?: string },
    res: ResponseLike,
    next: (err?: unknown) => void,
  ) {
    const query = queryOf(req.originalUrl ?? req.url);
    const locale = await this.resolution.resolve({ headers: req.headers, query });

    if (this.options.responseHeaders !== false) {
      this.setHeaders(res, locale);
    }

    i18nStorage.run({ locale, service: this.i18n }, () => next());
  }

  private setHeaders(res: ResponseLike, locale: string) {
    if (typeof res?.setHeader !== 'function') {
      return;
    }

    res.setHeader('Content-Language', locale);

    const vary = this.resolution.varyHeaders;
    if (!vary.length) {
      return;
    }
    res.setHeader('Vary', mergeVary(res.getHeader?.('vary'), vary));

    // Whatever sets Vary later replaces this value: a handler's @Header(), or
    // Fastify, which passes its reply headers (such as @fastify/cors's Vary)
    // to writeHead(). Merge once more, right before the headers go out.
    const writeHead = res.writeHead;
    if (typeof writeHead !== 'function') {
      return;
    }

    let merged = false;
    res.writeHead = function (this: ResponseLike, ...args: unknown[]) {
      if (!merged) {
        merged = true;
        mergeIntoWriteHead(res, args, vary);
      }
      return writeHead.apply(this, args);
    };
  }
}

/**
 * Adds `vary` to the Vary header that `writeHead(status, [message], [headers])`
 * is about to send: the one in `headers` when it has one (it wins over
 * setHeader()), the response's own otherwise. Rewrites `args` in place.
 */
function mergeIntoWriteHead(res: ResponseLike, args: unknown[], vary: readonly string[]) {
  const at = typeof args[1] === 'string' ? 2 : 1;
  const headers = args[at];
  if (Array.isArray(headers)) {
    // Raw form: [name, value, name, value, ...]
    const index = headers.findIndex((h, i) => i % 2 === 0 && String(h).toLowerCase() === 'vary');
    if (index !== -1) {
      args[at] = headers.with(index + 1, mergeVary(headers[index + 1], vary));
      return;
    }
  } else if (headers && typeof headers === 'object') {
    const name = Object.keys(headers).find((h) => h.toLowerCase() === 'vary');
    if (name !== undefined) {
      args[at] = { ...headers, [name]: mergeVary((headers as Record<string, unknown>)[name], vary) };
      return;
    }
  }

  res.setHeader!('Vary', mergeVary(res.getHeader?.('vary'), vary));
}

/** `current` plus the names it lacks, compared case-insensitively. `*` stays alone. */
function mergeVary(current: unknown, names: readonly string[]): string {
  const values = [current]
    .flat()
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.includes('*')) {
    return '*';
  }

  const present = new Set(values.map((value) => value.toLowerCase()));
  return [...values, ...names.filter((name) => !present.has(name.toLowerCase()))].join(', ');
}
