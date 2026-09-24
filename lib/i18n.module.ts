import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { I18nContext } from './context/i18n.context.js';
import { I18N_CATALOGS, I18N_MODULE_OPTIONS } from './i18n.constants.js';
import {
  ConfigurableModuleClass,
  missingLoaderError,
  type I18nForRootOptions,
  type I18nModuleAsyncOptions,
} from './i18n.module-definition.js';
import { I18nService } from './i18n.service.js';
import { I18nInterceptor } from './interceptors/i18n.interceptor.js';
import { I18nLoader } from './loaders/i18n.loader.js';
import { I18nMiddleware } from './middleware/i18n.middleware.js';
import { LocaleResolution } from './services/locale-resolution.service.js';

/**
 * The generated class types its statics as properties, which can't be
 * narrowed. Declared as methods, `forRoot()` can take loader and resolver
 * classes and require `loader`.
 */
interface ConfigurableI18nModule {
  new (): object;
  forRoot(options: I18nForRootOptions): DynamicModule;
  forRootAsync(options: I18nModuleAsyncOptions): DynamicModule;
}

/**
 * `I18nModule.forRoot({ loader, resolvers?, imports?, ...options })` or
 * `forRootAsync({ loader?, resolvers?, imports, inject, useFactory })`, whose
 * factory can also return `loader` and `resolvers` instances.
 * Global by default. Mounts the locale middleware on every route and a global
 * interceptor for entry points the middleware doesn't wrap.
 */
@Module({
  providers: [
    {
      provide: I18N_CATALOGS,
      useFactory: (loader: I18nLoader) => loader.load(),
      inject: [I18nLoader],
    },
    I18nService,
    I18nContext,
    LocaleResolution,
    { provide: APP_INTERCEPTOR, useClass: I18nInterceptor },
  ],
  exports: [I18nService, I18nContext, I18N_MODULE_OPTIONS],
})
export class I18nModule
  extends (ConfigurableModuleClass as ConfigurableI18nModule)
  implements NestModule
{
  static forRoot(options: I18nForRootOptions): DynamicModule {
    if (options?.loader === undefined) {
      throw missingLoaderError();
    }
    return super.forRoot(options);
  }

  static forRootAsync(options: I18nModuleAsyncOptions): DynamicModule {
    return super.forRootAsync(options);
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(I18nMiddleware).forRoutes('*');
  }
}
