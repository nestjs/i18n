import {
  Injectable,
  Optional,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';
import type { ValidationError, ValidatorOptions } from 'class-validator';
import {
  isTranslatedConstraint,
  translateValidationErrors,
  withoutTargets,
} from '../validation/validation-messages.js';

/**
 * `ValidationPipe` that localizes messages before the (default or custom)
 * `exceptionFactory` runs, so `errorFormat`, `exceptionFactory` etc. keep
 * working unchanged. Translated messages of nested objects aren't prefixed
 * with the parent path (put `{path}` in the message if you want it);
 * untranslated ones keep Nest's `parent.message` format.
 */
@Injectable()
export class I18nValidationPipe extends ValidationPipe {
  private readonly namespace?: string;

  constructor(
    @Optional()
    options?: ValidationPipeOptions & {
      /** Namespace for default constraint messages. Default `'validation'`. */
      namespace?: string;
    },
  ) {
    const { namespace, ...rest } = options ?? {};
    super(rest);
    this.namespace = namespace;
  }

  protected async validate(
    object: object,
    validatorOptions?: ValidatorOptions,
  ): Promise<ValidationError[]> {
    // The decorators are found through `error.target`, so validate with it and
    // drop it afterwards when the app turned it off.
    const errors = await super.validate(object, {
      ...validatorOptions,
      validationError: { ...validatorOptions?.validationError, target: true },
    });

    translateValidationErrors(errors, {
      namespace: this.namespace,
      groups: validatorOptions?.groups,
      always: validatorOptions?.always,
      strictGroups: validatorOptions?.strictGroups,
    });

    return validatorOptions?.validationError?.target === false ? withoutTargets(errors) : errors;
  }

  protected prependConstraintsWithParentProp(
    parentPath: string,
    error: ValidationError,
  ): ValidationError {
    const constraints: Record<string, string> = {};
    for (const [name, message] of Object.entries(error.constraints ?? {})) {
      constraints[name] = isTranslatedConstraint(error, name)
        ? message
        : `${parentPath}.${message}`;
    }

    return { ...error, constraints };
  }
}
