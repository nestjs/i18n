import type {
  I18nCatalogs,
} from '../interfaces/i18n-module-options.interface.js';
import { I18nLoader } from './i18n.loader.js';

/** Catalogs given as an object. For tests and small apps. */
export class InMemoryI18nLoader extends I18nLoader {
  constructor(private readonly catalogs: I18nCatalogs) {
    super();
  }

  load(): I18nCatalogs {
    return this.catalogs;
  }
}
