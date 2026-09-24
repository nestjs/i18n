import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  ForbiddenException,
  Get,
  Header,
  HttpException,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
  UsePipes,
  type CanActivate,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { IsEmail, IsNotEmpty, Min, MinLength } from 'class-validator';
import { fileURLToPath } from 'node:url';
import { signupSchema } from './schemas.js';
import {
  AcceptLanguageLocaleResolver,
  CurrentLocale,
  HeaderLocaleResolver,
  I18nContext,
  I18nModule,
  I18nService,
  I18nStandardSchemaValidationPipe,
  i18nValidationMessage,
  JsonI18nLoader,
  QueryLocaleResolver,
  t,
} from '../lib/index.js';

export const localesPath = fileURLToPath(
  new URL('./fixtures/locales', import.meta.url),
);

/** Mirrors fixtures/locales/en — what a typegen step would emit. */
export interface AppTranslations {
  users: {
    greeting: string;
    notFound: string;
    forbidden: string;
    tooYoung: string;
    onlyInEnglish: string;
    apples: { one: string; other: string };
  };
  validation: { isEmail: string; minLength: string; isNotEmpty: string };
}

export class CreateUserDto {
  @IsEmail()
  email: string;

  @MinLength(3)
  name: string;

  @Min(18, { message: i18nValidationMessage('users.tooYoung') })
  age: number;

  @IsNotEmpty({ message: 'nickname: custom untranslated message' })
  nickname: string;
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException(t('users.forbidden'));
  }
}

/** A user-land filter with its own response shape (think RFC 9457). */
@Catch(HttpException)
class CustomShapeFilter implements ExceptionFilter {
  constructor(private readonly host: HttpAdapterHost) {}
  catch(exception: HttpException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    this.host.httpAdapter.reply(
      res,
      { title: exception.message, status: exception.getStatus() },
      exception.getStatus(),
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Controller()
export class AppController {
  constructor(
    private readonly i18n: I18nService<AppTranslations>,
    private readonly i18nContext: I18nContext,
  ) {}

  @Get('greet')
  greet(@Query('name') name: string, @CurrentLocale() locale: string) {
    return { locale, message: this.i18n.t('users.greeting', { args: { name } }) };
  }

  @Get('apples')
  apples(@Query('count') count: string) {
    return {
      message: this.i18n.t('users.apples', { args: { count: Number(count) } }),
    };
  }

  @Get('english-only')
  englishOnly() {
    return { message: this.i18n.t('users.onlyInEnglish') };
  }

  @Get('own-vary')
  @Header('Vary', 'X-Tenant')
  ownVary() {
    return { message: this.i18n.t('users.forbidden') };
  }

  @Get('users/:id')
  findOne(@Param('id') id: string) {
    throw new NotFoundException(t('users.notFound', { args: { id } }));
  }

  @Get('guarded')
  @UseGuards(DenyGuard)
  guarded() {
    return 'unreachable';
  }

  @Get('custom-filter/:id')
  @UseFilters(CustomShapeFilter)
  customFilter(@Param('id') id: string) {
    throw new NotFoundException(t('users.notFound', { args: { id } }));
  }

  @Post('users')
  create(@Body() dto: CreateUserDto) {
    return dto;
  }

  @Post('signup')
  @UsePipes(new I18nStandardSchemaValidationPipe())
  signup(@Body({ schema: signupSchema }) body: unknown) {
    return body;
  }

  @Get('slow')
  async slow(@Query('delay') delay: string, @Query('name') name: string) {
    await sleep(Number(delay));
    const before = this.i18nContext.locale;
    await sleep(Number(delay) / 2);
    return {
      locale: before,
      after: this.i18nContext.locale,
      message: this.i18n.t('users.greeting', { args: { name } }),
      price: this.i18n.formatNumber(1234.5),
    };
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      defaultLocale: 'en',
      fallbacks: { 'de-AT': 'de', 'de-CH': 'de' },
      loader: new JsonI18nLoader({ path: localesPath }),
      resolvers: [
        new QueryLocaleResolver('lang'),
        new HeaderLocaleResolver('x-lang'),
        new AcceptLanguageLocaleResolver(),
      ],
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}
