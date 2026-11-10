import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  CurrentLocale,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
} from '../lib/index.js';
import { adapters, createApp } from './support/adapters.js';

@Controller()
class GreetingController {
  constructor(private readonly i18n: I18nService) {}

  @Get()
  greet(@CurrentLocale() locale: string) {
    return { locale, message: this.i18n.t('hi') };
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      supportedLocales: ['en', 'pt-br'],
      loader: new InMemoryI18nLoader({
        EN: { hi: 'Hi' },
        'pt-BR': { hi: 'Olá' },
      }),
    }),
  ],
  controllers: [GreetingController],
})
class GreetingModule {}

describe.each(adapters)('catalog spelling over $name', ({ name }) => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp(name, GreetingModule);
  });
  afterAll(() => app.close());

  it('translates with the catalog spelling and keeps the configured response locale', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Accept-Language', 'PT-BR')
      .expect(200);
    expect(response.body).toEqual({ locale: 'pt-br', message: 'Olá' });
    expect(response.headers['content-language']).toBe('pt-br');
  });
});
