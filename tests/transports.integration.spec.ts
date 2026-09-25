/**
 * Validation, exceptions and guards on the entry points the middleware doesn't wrap: a hybrid
 * app's TCP microservice and a `ws` gateway, where the interceptor enters the locale.
 */
import {
  Controller,
  Get,
  Injectable,
  Module,
  Query,
  UseGuards,
  UsePipes,
  type CanActivate,
  type INestApplication,
  type ValidationError,
} from '@nestjs/common';
import {
  ClientProxyFactory,
  MessagePattern,
  Payload,
  RpcException,
  Transport,
  type ClientProxy,
} from '@nestjs/microservices';
import { WsAdapter } from '@nestjs/platform-ws';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import { IsEmail, MinLength } from 'class-validator';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom } from 'rxjs';
import request from 'supertest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { createApp } from './support/adapters.js';
import {
  CurrentLocale,
  HeaderLocaleResolver,
  I18nModule,
  I18nService,
  I18nStandardSchemaValidationPipe,
  I18nValidationPipe,
  InMemoryI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  t,
  type LocaleResolverInput,
} from '../lib/index.js';

const catalogs = {
  en: {
    users: { greeting: 'Hello, {name}!', notFound: 'User #{id} was not found', forbidden: 'Not allowed' },
    validation: {
      isEmail: '{property} must be a valid email address',
      minLength: '{property} must be at least {constraint1} characters long',
      too_small: { string: '{property} must be at least {minimum} characters long' },
    },
  },
  pl: {
    users: { greeting: 'Cześć, {name}!', notFound: 'Nie znaleziono użytkownika #{id}', forbidden: 'Brak dostępu' },
    validation: {
      isEmail: '{property} musi być poprawnym adresem e-mail',
      minLength: '{property} musi mieć co najmniej {constraint1} znaki',
      too_small: { string: '{property} musi mieć co najmniej {minimum} znaki' },
    },
  },
};

class CreateUserDto {
  @IsEmail()
  email: string;

  @MinLength(3)
  name: string;
}

const RenameUser = z.object({ name: z.string().min(3) });

const toMessages = (errors: ValidationError[]) =>
  errors.flatMap((error) => Object.values(error.constraints ?? {}));

/** A guard on an entry point without the middleware: it runs before the interceptor enters a locale. */
@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new RpcException(t('users.forbidden'));
  }
}

/** Producers put the customer's locale into the message; HTTP requests say it in a header. */
@Injectable()
class MessageLocaleResolver extends LocaleResolver {
  resolve({ executionContext }: LocaleResolverInput) {
    if (executionContext?.getType() !== 'rpc') {
      return undefined;
    }
    return executionContext.switchToRpc().getData<{ locale?: string }>()?.locale;
  }
}

@Controller()
class UsersController {
  constructor(private readonly i18nService: I18nService) {}

  @Get('greet')
  greet(@Query('name') name: string, @CurrentLocale() locale: string) {
    return { locale, message: this.i18nService.translate('users.greeting', { args: { name } }) };
  }

  @MessagePattern('users.greet')
  greetMessage(@Payload() data: { name: string }, @CurrentLocale() locale: string) {
    return { locale, message: this.i18nService.translate('users.greeting', { args: { name: data.name } }) };
  }

  @MessagePattern('users.create')
  @UsePipes(new I18nValidationPipe({ exceptionFactory: (errors) => new RpcException(toMessages(errors)) }))
  create(@Payload() dto: CreateUserDto) {
    return dto;
  }

  @MessagePattern('users.rename')
  @UsePipes(
    new I18nStandardSchemaValidationPipe({
      exceptionFactory: (issues) => new RpcException(issues.map((issue) => issue.message)),
    }),
  )
  rename(@Payload({ schema: RenameUser }) data: { name: string }) {
    return data;
  }

  @MessagePattern('users.guarded')
  @UseGuards(DenyGuard)
  guarded() {
    return 'unreachable';
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      loader: new InMemoryI18nLoader(catalogs),
      resolvers: [MessageLocaleResolver, new HeaderLocaleResolver('x-lang')],
    }),
  ],
  controllers: [UsersController],
})
class HybridAppModule {}

describe('a hybrid app: HTTP and a TCP microservice in one application', () => {
  let app: INestApplication;
  let client: ClientProxy;

  // Without inheritAppConfig, the connected microservice doesn't get the module's global
  // interceptor, which is what enters the locale on this transport.
  beforeAll(async () => {
    app = await createApp('express', HybridAppModule, {
      setup: (a) => {
        a.connectMicroservice(
          { transport: Transport.TCP, options: { host: '127.0.0.1', port: 0 } },
          { inheritAppConfig: true },
        );
      },
    });
    await app.startAllMicroservices();
    const [microservice] = app.getMicroservices();
    const { port } = microservice.unwrap<Server>().address() as AddressInfo;
    client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: '127.0.0.1', port } });
    await client.connect();
  });
  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  const send = <T>(pattern: string, data: object) => firstValueFrom(client.send<T>(pattern, data));

  it('one resolver list serves both: the message on TCP, the header on HTTP', async () => {
    const [http, message] = await Promise.all([
      request(app.getHttpServer()).get('/greet?name=Ada').set('x-lang', 'pl').expect(200),
      send('users.greet', { name: 'Ada', locale: 'en-GB' }),
    ]);

    expect(http.body).toEqual({ locale: 'pl', message: 'Cześć, Ada!' });
    expect(http.headers['content-language']).toBe('pl');
    expect(message).toEqual({ locale: 'en', message: 'Hello, Ada!' });
  });

  it('I18nValidationPipe translates class-validator messages for the locale of the message', async () => {
    await expect(send('users.create', { email: 'nope', name: 'Al', locale: 'pl' })).rejects.toEqual([
      'email musi być poprawnym adresem e-mail',
      'name musi mieć co najmniej 3 znaki',
    ]);
    await expect(send('users.create', { email: 'nope', name: 'Al' })).rejects.toEqual([
      'email must be a valid email address',
      'name must be at least 3 characters long',
    ]);
  });

  it('I18nStandardSchemaValidationPipe translates Standard Schema issues for the locale of the message', async () => {
    await expect(send('users.rename', { name: 'Al', locale: 'pl-PL' })).rejects.toEqual([
      'name musi mieć co najmniej 3 znaki',
    ]);
  });

  it('guards run before the interceptor, so t() in an RPC guard has no locale and returns the key', async () => {
    await expect(send('users.guarded', { locale: 'pl' })).rejects.toEqual({
      status: 'error',
      message: 'users.forbidden',
    });
  });
});

describe('WebSocket gateways (ws): validation and exceptions', () => {
  @WebSocketGateway({ path: '/ws' })
  class UsersGateway implements OnGatewayConnection {
    constructor(private readonly i18nService: I18nService) {}

    handleConnection(client: WebSocket & { request?: IncomingMessage }, request: IncomingMessage) {
      client.request = request;
    }

    @SubscribeMessage('users.create')
    @UsePipes(new I18nValidationPipe({ exceptionFactory: (errors) => new WsException(toMessages(errors)) }))
    create(@MessageBody() dto: CreateUserDto) {
      return { event: 'users.created', data: { name: dto.name, greeting: this.i18nService.translate('users.greeting', { args: { name: dto.name } }) } };
    }

    @SubscribeMessage('users.find')
    find(@MessageBody() data: { id: number }) {
      throw new WsException(t('users.notFound', { args: { id: data.id } }));
    }
  }

  @Module({
    imports: [
      I18nModule.forRoot({
        loader: new InMemoryI18nLoader(catalogs),
        resolvers: [new QueryLocaleResolver('lang'), new HeaderLocaleResolver('x-lang')],
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

  const exchange = async (query: string, headers: Record<string, string>, event: string, data: object) => {
    const socket = new WebSocket(base + query, { headers });
    sockets.push(socket);
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));

    const reply = new Promise<{ event: string; data: unknown }>((resolve) =>
      socket.once('message', (raw) => resolve(JSON.parse(String(raw)))),
    );
    socket.send(JSON.stringify({ event, data }));
    return reply;
  };

  it('translates validation messages for the locale of the handshake', async () => {
    const reply = await exchange('?lang=pl', {}, 'users.create', { email: 'nope', name: 'Al' });

    expect(reply).toEqual({
      event: 'exception',
      data: ['email musi być poprawnym adresem e-mail', 'name musi mieć co najmniej 3 znaki'],
    });
  });

  it('passes valid messages to the handler, which translates in the same locale', async () => {
    const reply = await exchange('', { 'x-lang': 'pl' }, 'users.create', { email: 'ada@example.com', name: 'Ada' });

    expect(reply).toEqual({ event: 'users.created', data: { name: 'Ada', greeting: 'Cześć, Ada!' } });
  });

  it('translates WsException messages thrown with t()', async () => {
    const reply = await exchange('', { 'x-lang': 'pl' }, 'users.find', { id: 7 });

    expect(reply).toMatchObject({ event: 'exception', data: { status: 'error', message: 'Nie znaleziono użytkownika #7' } });
  });
});
