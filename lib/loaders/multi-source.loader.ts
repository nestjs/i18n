import type {
  I18nCatalog,
  I18nCatalogs,
} from '../interfaces/i18n-module-options.interface.js';
import type { MultiSourceI18nLoaderOptions } from '../interfaces/multi-source-loader-options.interface.js';
import { I18nLoader } from './i18n.loader.js';

/**
 * Loads catalogs from several loaders and merges them locale by locale.
 *
 * Loaders are merged in the order given, so later loaders override earlier
 * ones. Nested objects are merged recursively; arrays and primitive values
 * are replaced. If any loader fails, the whole load fails.
 */
export class MultiSourceI18nLoader extends I18nLoader {
  constructor(readonly options: Readonly<MultiSourceI18nLoaderOptions>) {
    if (!options.loaders.length) {
      throw new Error(
        'MultiSourceI18nLoader: the loaders list cannot be empty.',
      );
    }

    super();
  }

  async load(): Promise<I18nCatalogs> {
    const catalogsList = await Promise.all(
      this.options.loaders.map((loader) => loader.load()),
    );

    return mergeI18nCatalogs(...catalogsList);
  }

  /** Watches every loader; a change in any of them reports once to `onChange`. */
  watch(onChange: (catelogs: I18nCatalogs) => void): () => void {
    const stops: (() => void)[] = [];

    for (const laoder of this.options.loaders) {
      if (laoder.watch) {
        stops.push(laoder.watch(onChange));
      }
    }

    return () => stops.forEach((stop) => stop());
  }
}

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/**
 * Assigns an own data property. Plain assignment would hit the `__proto__`
 * setter, so keys such as `__proto__` are kept as ordinary keys instead.
 */
function setOwn(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isPlainObject(value: unknown): value is I18nCatalog {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively merges `source` into a copy of `target`; inputs are not mutated. */
function mergeSingleCatalog(
  target: I18nCatalog,
  source: I18nCatalog,
): I18nCatalog {
  const output: I18nCatalog = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = hasOwn(target, key) ? target[key] : undefined;

    setOwn(
      output,
      key,
      isPlainObject(sourceVal) && isPlainObject(targetVal)
        ? mergeSingleCatalog(targetVal, sourceVal)
        : sourceVal,
    );
  }

  return output;
}

/** Merges I18nCatalogs collections locale by locale; inputs are not mutated. */
function mergeI18nCatalogs(...catalogsList: I18nCatalogs[]): I18nCatalogs {
  const result: I18nCatalogs = {};

  for (const catalogs of catalogsList) {
    for (const locale of Object.keys(catalogs)) {
      setOwn(
        result,
        locale,
        mergeSingleCatalog(
          hasOwn(result, locale) ? result[locale] : {},
          catalogs[locale],
        ),
      );
    }
  }

  return result;
}
