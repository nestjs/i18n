import { Inject, Injectable, Logger } from '@nestjs/common';
import { I18N_RESOLVERS } from '../i18n.constants.js';
import { I18nService } from '../i18n.service.js';
import type {
  LocaleResolverInput,
} from '../interfaces/locale-resolver-input.interface.js';
import type { LocaleResolver } from '../resolvers/locale.resolver.js';

/**
 * Runs the configured resolvers in order; the first candidate that matches a
 * supported locale wins (internal, shared by the middleware and interceptor).
 */
@Injectable()
export class LocaleResolution {
  private readonly logger = new Logger('I18nModule');
  /** The headers the resolvers read, deduplicated, for `Vary`. */
  readonly varyHeaders: string[];

  constructor(
    @Inject(I18N_RESOLVERS) private readonly resolvers: LocaleResolver[],
    private readonly i18n: I18nService,
  ) {
    const seen = new Set<string>();
    this.varyHeaders = resolvers
      .flatMap((resolver) => resolver.varyHeaders ?? [])
      .filter((name) => !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()));
  }

  async resolve(input: LocaleResolverInput): Promise<string> {
    for (const resolver of this.resolvers) {
      let result;
      try {
        result = await resolver.resolve(input);
      } catch (err) {
        this.logger.error(
          `Locale resolver ${resolver.constructor.name} failed: ${String(err)}`,
          (err as Error | undefined)?.stack,
        );
        continue;
      }

      const candidates = Array.isArray(result) ? result : [result];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
          continue;
        }
        const match = this.i18n.matchLocale(candidate);
        if (match) {
          return match;
        }
      }
    }
    return this.i18n.defaultLocale;
  }
}
