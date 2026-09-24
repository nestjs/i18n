import {
  Injectable,
  Optional,
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
} from '@nestjs/common';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  TranslateIssuesOptions,
} from '../interfaces/validation-options.interface.js';
import {
  isTranslatedIssue,
  translateStandardSchemaIssues,
} from '../validation/standard-schema-messages.js';

/**
 * `StandardSchemaValidationPipe` with localized issues. Translation happens
 * in `validate()`, so a custom `exceptionFactory` receives translated issues.
 * Translated messages are not prefixed with `path: ` (put `{path}` in the
 * message if you want it); untranslated ones keep Nest's default format.
 */
@Injectable()
export class I18nStandardSchemaValidationPipe extends StandardSchemaValidationPipe {
  private readonly i18nOptions: TranslateIssuesOptions;

  constructor(
    @Optional() options?: StandardSchemaValidationPipeOptions & TranslateIssuesOptions,
  ) {
    const { namespace, issueKeys, ...rest } = options ?? {};
    super(rest);
    this.i18nOptions = { namespace, issueKeys };
  }

  protected async validate<T = unknown>(
    value: unknown,
    schema: StandardSchemaV1,
    options?: Record<string, unknown>,
  ): Promise<StandardSchemaV1.Result<T>> {
    const result = await super.validate<T>(value, schema, options);

    if (!result.issues) {
      return result;
    }
    return { issues: translateStandardSchemaIssues(result.issues, this.i18nOptions) };
  }

  protected formatIssueMessages(
    issues: readonly StandardSchemaV1.Issue[],
  ): string[] {
    return issues.map((issue) =>
      isTranslatedIssue(issue)
        ? issue.message
        : super.formatIssueMessages([issue])[0],
    );
  }
}
