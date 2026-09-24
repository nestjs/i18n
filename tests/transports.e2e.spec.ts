/**
 * Microservices and WebSocket gateways have no HTTP middleware, so the global
 * interceptor enters the locale: from the message (a resolver that reads the
 * payload) or from the WebSocket handshake.
 */
import { Controller, Injectable, Module, type INestApplication, type INestMicroservice } from '@nestjs/common';
import {
  ClientProxyFactory,
  MessagePattern,
  Payload,
  RpcException,
  Transport,
  type ClientProxy,
} from '@nestjs/microservices';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { SubscribeMessage, WebSocketGateway, type OnGatewayConnection } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom } from 'rxjs';
import { WebSocket } from 'ws';
import { createApp } from './support/adapters.js';
import {
  AcceptLanguageLocaleResolver,
  CurrentLocale,
  I18nContext,
  I18nModule,
  I18nService,
  JsonI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  t,
  type LocaleResolverInput,
} from '../lib/index.js';
import { localesPath, type AppTranslations } from './app.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('microservices (TCP): the locale from the message', () => {
  /** Producers put the customer's locale into the message. */
  @Injectable()
  class MessageLocaleResolver extends LocaleResolver {
    resolve({ executionContext }: LocaleResolverInput) {
      return executionContext?.switchToRpc().getData<{ locale?: string }>()?.locale;
    }
  }

  @Controller()
  class UsersHandlers {
    constructor(
      private readonly i18n: I18nService<AppTranslations>,
      private readonly i18nContext: I18nContext,
    ) {}

    @MessagePattern('users.greet')
    async greet(@Payload() data: { name: string; delay: number }, @CurrentLocale() locale: string) {
      await sleep(data.delay);
      return {
        locale,
        after: this.i18nContext.locale,
        message: this.i18n.t('users.greeting', { args: { name: data.name } }),
      };
    }

    @MessagePattern('users.find')
    find(@Payload() data: { id: number }) {
      throw new RpcException(t('users.notFound', { args: { id: data.id } }));
    }
  }

  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new JsonI18nLoader({ path: localesPath }),
        resolvers: [MessageLocaleResolver],
      }),
    ],
    controllers: [UsersHandlers],
  })
  class RpcAppModule {}

  let microservice: INestMicroservice;
  let client: ClientProxy;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RpcAppModule] }).compile();
    microservice = moduleRef.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: 0 },
    });
    microservice.useLogger(false);
    await microservice.listen();
    const { port } = microservice.unwrap<Server>().address() as AddressInfo;
    client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: '127.0.0.1', port } });
    await client.connect();
  });
  afterAll(async () => {
    await client?.close();
    await microservice?.close();
  });

  const send = <T>(pattern: string, data: object) => firstValueFrom(client.send<T>(pattern, data));

  it('translates in handlers and in exceptions, per message', async () => {
    expect(await send('users.greet', { name: 'Ada', delay: 0, locale: 'pl-PL' })).toEqual({
      locale: 'pl',
      after: 'pl',
      message: 'Cześć, Ada!',
    });
    expect(await send('users.greet', { name: 'Ada', delay: 0 })).toMatchObject({ locale: 'en' });
    await expect(send('users.find', { id: 7, locale: 'de' })).rejects.toEqual({
      status: 'error',
      message: 'Benutzer #7 wurde nicht gefunden',
    });
  });

  it('does not bleed locales between concurrent messages', async () => {
    const locales = ['pl', 'de', 'en', 'pl', 'de', 'en', 'pl', 'de'];
    const greetings: Record<string, string> = { pl: 'Cześć, N!', de: 'Hallo, N!', en: 'Hello, N!' };
    const replies = await Promise.all(
      locales.map((locale, i) =>
        send<{ locale: string; after: string; message: string }>('users.greet', {
          name: 'N',
          delay: (locales.length - i) * 5,
          locale,
        }),
      ),
    );
    replies.forEach((reply, i) =>
      expect(reply).toEqual({ locale: locales[i], after: locales[i], message: greetings[locales[i]] }),
    );
  });
});

describe('WebSocket gateways (ws): the locale from the handshake', () => {
  @WebSocketGateway({ path: '/ws' })
  class UsersGateway implements OnGatewayConnection {
    constructor(private readonly i18n: I18nService<AppTranslations>) {}

    // The `ws` library keeps no reference to the upgrade request. Storing it on
    // `client.request` (as WsAuthenticator does) lets the built-in resolvers
    // read its headers and query; socket.io's `handshake` works as is.
    handleConnection(client: WebSocket & { request?: IncomingMessage }, request: IncomingMessage) {
      client.request = request;
    }

    @SubscribeMessage('greet')
    async greet(_client: WebSocket, data: { name: string; delay: number }) {
      await sleep(data.delay);
      return { event: 'greeting', data: this.i18n.t('users.greeting', { args: { name: data.name } }) };
    }
  }

  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new JsonI18nLoader({ path: localesPath }),
        resolvers: [new QueryLocaleResolver('lang'), new AcceptLanguageLocaleResolver()],
      }),
    ],
    providers: [UsersGateway],
  })
  class WsAppModule {}

  let app: INestApplication;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    app = await createApp('express', WsAppModule, {
      setup: (a) => void a.useWebSocketAdapter(new WsAdapter(a)),
    });
    base = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/ws`;
  });
  afterEach(() => sockets.splice(0).forEach((socket) => socket.close()));
  afterAll(() => app.close());

  const greet = async (path: string, headers: Record<string, string>, name: string, delay = 0) => {
    const socket = new WebSocket(base + path, { headers });
    sockets.push(socket);
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    const reply = new Promise<string>((resolve) => socket.once('message', (raw) => resolve(String(raw))));
    socket.send(JSON.stringify({ event: 'greet', data: { name, delay } }));
    return JSON.parse(await reply).data as string;
  };

  it('reads the handshake headers and query', async () => {
    expect(await greet('', { 'accept-language': 'pl-PL' }, 'Ada')).toBe('Cześć, Ada!');
    expect(await greet('?lang=de', { 'accept-language': 'pl' }, 'Ada')).toBe('Hallo, Ada!');
    expect(await greet('', {}, 'Ada')).toBe('Hello, Ada!');
  });

  it('does not bleed locales between concurrent connections', async () => {
    const locales = ['pl', 'de', 'en', 'pl', 'de', 'en'];
    const greetings: Record<string, string> = { pl: 'Cześć, N!', de: 'Hallo, N!', en: 'Hello, N!' };
    const replies = await Promise.all(
      locales.map((locale, i) => greet(`?lang=${locale}`, {}, 'N', (locales.length - i) * 5)),
    );
    replies.forEach((reply, i) => expect(reply).toBe(greetings[locales[i]]));
  });
});
