// Module
export { I18N_MODULE_OPTIONS } from './i18n.constants.js';
export { I18nModule } from './i18n.module.js';
export type {
  I18nForRootOptions,
  I18nModuleAsyncOptions,
  I18nOptionsFactory,
} from './i18n.module-definition.js';
export type {
  I18nCatalog,
  I18nCatalogs,
  I18nMissingKeyPolicy,
  I18nModuleOptions,
  I18nKey,
  I18nTypes,
  I18nDateFormatOptions,
  I18nNumberFormatOptions,
  I18nTranslateOptions,
  JsonI18nLoaderOptions,
  LocaleResolverInput,
} from './interfaces/index.js';

// Translating: the service, the request's locale, and t() for code without DI
export { I18nService } from './i18n.service.js';
export { I18nContext } from './context/index.js';
export * from './decorators/index.js';
export { t } from './context/index.js';
export * from './errors/index.js';

// Catalog loaders
export * from './loaders/index.js';

// Locale resolvers
export {
  LocaleResolver,
  AcceptLanguageLocaleResolver,
  CookieLocaleResolver,
  HeaderLocaleResolver,
  QueryLocaleResolver,
} from './resolvers/index.js';

// Validation messages: class-validator and Standard Schema
export * from './pipes/index.js';
export {
  i18nValidationMessage,
  translateValidationErrors,
  i18nIssueMessage,
  translateStandardSchemaIssues,
} from './validation/index.js';
