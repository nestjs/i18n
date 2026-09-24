import { createParamDecorator } from '@nestjs/common';
import { i18nStorage } from '../context/i18n.storage.js';

/** Injects the current request's locale: `@CurrentLocale() locale: string`. */
export const CurrentLocale: () => ParameterDecorator = createParamDecorator(
  () => i18nStorage.getStore()?.locale,
);
