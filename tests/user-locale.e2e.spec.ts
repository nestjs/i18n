/**
 * The locale saved on the signed-in user: an `afterGuards` resolver reads the
 * user an authentication guard identified, keeping its rank among the
 * resolvers, and `I18nContext.setLocale()` switches the locale mid-request.
 */
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type INestMicroservice,
} from '@nestjs/common';
import { Args, GraphQLModule, Query, Resolver } from '@nestjs/graphql';
import {
  ClientProxyFactory,
  MessagePattern,
  Payload,
  Transport,
  type ClientProxy,
} from '@nestjs/microservices';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { SubscribeMessage, WebSocketGateway, type OnGatewayConnection } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom } from 'rxjs';
import request from 'supertest';
import { WebSocket } from 'ws';
import { adapters, createApp } from './support/adapters.js';
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

interface Customer {
  id: number;
  locale: string | null;
}

/** Saved languages: Polish, German, none, and one the app doesn't support. */
@Injectable()
class CustomersRepository {
  private readonly customers: Customer[] = [
    { id: 1, locale: 'pl' },
    { id: 2, locale: 'de-DE' },
    { id: 3, locale: null },
    { id: 4, locale: 'fr' },
  ];

  async findOne(id: number): Promise<Customer | undefined> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return this.customers.find((customer) => customer.id === id);
  }
}

@Module({ providers: [CustomersRepository], exports: [CustomersRepository] })
class CustomersModule {}

/** Where each transport keeps the signed-in user, as `@nestjs/authentication` mirrors it. */
function carrierOf(context: ExecutionContext): { user?: { id: number } } | undefined {
  switch (context.getType<string>()) {
    case 'http':
      return context.switchToHttp().getRequest();
    case 'graphql':
      return context.getArgByIndex(2)?.req;
    case 'ws':
      return context.switchToWs().getClient();
    case 'rpc':
      return context.switchToRpc().getContext();
    default:
      return undefined;
  }
}

/** `Bearer <id>` from the request, the handshake, or an RPC message's `token`. */
function tokenOf(context: ExecutionContext): string | undefined {
  switch (context.getType<string>()) {
    case 'rpc':
      return context.switchToRpc().getData()?.token;
    case 'ws':
      return context.switchToWs().getClient<{ request?: IncomingMessage }>().request?.headers.authorization;
    default:
      return (carrierOf(context) as Partial<IncomingMessage> | undefined)?.headers?.authorization;
  }
}

/** A stand-in for an authentication guard: puts the user on the carrier, records what it saw. */
@Injectable()
class AuthGuard implements CanActivate {
  constructor(private readonly i18nContext: I18nContext) {}

  canActivate(context: ExecutionContext): boolean {
    const carrier = carrierOf(context)!;
    (carrier as { guardLocale?: string }).guardLocale = this.i18nContext.locale;

    const token = tokenOf(context);
    if (token === 'Bearer invalid') {
      throw new UnauthorizedException(t('users.forbidden'));
    }
    const id = token?.startsWith('Bearer ') ? Number(token.slice(7)) : undefined;
    carrier.user = id ? { id } : undefined;
    return true;
  }
}

@Injectable()
class CustomerLocaleResolver extends LocaleResolver {
  readonly afterGuards = true;
  readonly varyHeaders = ['Authorization'];
  calls = 0;

  constructor(private readonly customersRepository: CustomersRepository) {
    super();
  }

  async resolve({ executionContext }: LocaleResolverInput) {
    this.calls++;
    const user = executionContext && carrierOf(executionContext)?.user;
    return user ? (await this.customersRepository.findOne(user.id))?.locale : undefined;
  }
}

function i18nModule(resolvers = [QueryLocaleResolver, CustomerLocaleResolver, AcceptLanguageLocaleResolver]) {
  return I18nModule.forRoot({
    loader: new JsonI18nLoader({ path: localesPath }),
    resolvers,
    imports: [CustomersModule],
  });
}

/** Picks German in a guard, before the saved language would apply. */
@Injectable()
class GermanGuard implements CanActivate {
  constructor(private readonly i18nContext: I18nContext) {}

  canActivate(): boolean {
    this.i18nContext.setLocale('de');
    return true;
  }
}

@Controller()
@UseGuards(AuthGuard)
class GreetingController {
  constructor(
    private readonly i18nService: I18nService<AppTranslations>,
    private readonly i18nContext: I18nContext,
  ) {}

  @Get('greeting')
  greet(@CurrentLocale() locale: string, @Req() req: { guardLocale?: string }) {
    return { locale, guard: req.guardLocale, message: this.i18nService.t('users.greeting', { args: { name: 'Ada' } }) };
  }

  @Put('me/locale')
  changeLocale(@Body() body: { locale: string }) {
    const locale = this.i18nContext.setLocale(body.locale) ?? null;
    return { locale, current: this.i18nContext.locale, message: t('users.greeting', { args: { name: 'Ada' } }) };
  }

  @Get('picked-in-guard')
  @UseGuards(GermanGuard)
  pickedInGuard(@CurrentLocale() locale: string) {
    return { locale };
  }
}

describe.each(adapters)('HTTP ($name): the saved locale of the signed-in customer', ({ name }) => {
  @Module({
    imports: [i18nModule()],
    controllers: [GreetingController],
    providers: [AuthGuard, GermanGuard],
  })
  class HttpAppModule {}

  let app: INestApplication;
  let resolver: CustomerLocaleResolver;

  beforeAll(async () => {
    app = await createApp(name, HttpAppModule);
    resolver = app.get(CustomerLocaleResolver);
  });
  afterAll(() => app.close());

  const greet = (path: string, headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer()).get(path);
    for (const [header, value] of Object.entries(headers)) {
      req.set(header, value);
    }
    return req;
  };

  it('answers in the saved language, over Accept-Language', async () => {
    const res = await greet('/greeting', { authorization: 'Bearer 1', 'accept-language': 'de' }).expect(200);

    expect(res.body).toEqual({ locale: 'pl', guard: 'de', message: 'Cześć, Ada!' });
    expect(res.headers['content-language']).toBe('pl');
    expect(res.headers.vary).toBe('Authorization, Accept-Language');
  });

  it('matches the saved locale like a candidate: de-DE → de', async () => {
    const res = await greet('/greeting', { authorization: 'Bearer 2' }).expect(200);

    expect(res.body.locale).toBe('de');
    expect(res.headers['content-language']).toBe('de');
  });

  it('lets a resolver ranked above it win: ?lang beats the saved language', async () => {
    const before = resolver.calls;
    const res = await greet('/greeting?lang=de', { authorization: 'Bearer 1' }).expect(200);

    expect(res.body).toEqual({ locale: 'de', guard: 'de', message: 'Hallo, Ada!' });
    expect(resolver.calls).toBe(before);
  });

  it('falls through to the resolvers below it without a user or a supported saved locale', async () => {
    expect((await greet('/greeting', { 'accept-language': 'de' })).body.locale).toBe('de');
    expect((await greet('/greeting', { authorization: 'Bearer 3', 'accept-language': 'de' })).body.locale).toBe('de');
    expect((await greet('/greeting', { authorization: 'Bearer 4', 'accept-language': 'de' })).body.locale).toBe('de');
    expect((await greet('/greeting', { authorization: 'Bearer 4' })).body.locale).toBe('en');
  });

  it('answers errors thrown by guards in the locale resolved before guards', async () => {
    const res = await greet('/greeting', { authorization: 'Bearer invalid', 'accept-language': 'pl' }).expect(401);

    expect(res.body.message).toBe('Nie masz dostępu do tego zasobu');
    expect(res.headers['content-language']).toBe('pl');
  });

  it('runs once per request, and keeps concurrent requests apart', async () => {
    const before = resolver.calls;
    const users = [1, 2, 3, 1, 2, 3];
    const replies = await Promise.all(
      users.map((id) => greet('/greeting', { authorization: `Bearer ${id}`, 'accept-language': 'en' })),
    );

    expect(replies.map((res) => res.body.locale)).toEqual(['pl', 'de', 'en', 'pl', 'de', 'en']);
    expect(resolver.calls - before).toBe(users.length);
  });

  it('setLocale() switches the rest of the request and Content-Language', async () => {
    const res = await request(app.getHttpServer())
      .put('/me/locale')
      .set('authorization', 'Bearer 1')
      .send({ locale: 'de-AT' })
      .expect(200);

    expect(res.body).toEqual({ locale: 'de', current: 'de', message: 'Hallo, Ada!' });
    expect(res.headers['content-language']).toBe('de');
  });

  it('setLocale() leaves the locale alone for an unsupported one, and returns undefined', async () => {
    const res = await request(app.getHttpServer())
      .put('/me/locale')
      .set('authorization', 'Bearer 1')
      .send({ locale: 'fr' })
      .expect(200);

    expect(res.body).toEqual({ locale: null, current: 'pl', message: 'Cześć, Ada!' });
    expect(res.headers['content-language']).toBe('pl');
  });

  it('setLocale() in a guard wins over the saved language', async () => {
    const res = await greet('/picked-in-guard', { authorization: 'Bearer 1' }).expect(200);

    expect(res.body).toEqual({ locale: 'de' });
    expect(res.headers['content-language']).toBe('de');
  });
});

describe('setLocale() outside a locale context', () => {
  it('throws, pointing at run() and afterGuards resolvers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [i18nModule()],
    }).compile();

    expect(() => moduleRef.get(I18nContext).setLocale('pl')).toThrow(
      /outside a locale context.*afterGuards.*I18nContext\.run\(\)/s,
    );
    await moduleRef.close();
  });
});

describe('GraphQL (Apollo, express): the saved locale, once per operation', () => {
  @Resolver()
  @UseGuards(AuthGuard)
  class GreetingResolver {
    constructor(private readonly i18nService: I18nService<AppTranslations>) {}

    @Query(() => String)
    async greeting(@Args('name') name: string, @CurrentLocale() locale: string) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `${locale}: ${this.i18nService.t('users.greeting', { args: { name } })}`;
    }
  }

  @Module({
    imports: [
      i18nModule(),
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        context: ({ req }: { req: unknown }) => ({ req }),
      }),
    ],
    providers: [AuthGuard, GreetingResolver],
  })
  class GqlAppModule {}

  let app: INestApplication;
  let resolver: CustomerLocaleResolver;

  beforeAll(async () => {
    app = await createApp('express', GqlAppModule);
    resolver = app.get(CustomerLocaleResolver);
  });
  afterAll(() => app.close());

  it('reads the user the guard put on the request, for every root field', async () => {
    const before = resolver.calls;
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .set('authorization', 'Bearer 1')
      .set('accept-language', 'de')
      .send({ query: '{ a: greeting(name: "Ada") b: greeting(name: "Olek") }' })
      .expect(200);

    expect(res.body.data).toEqual({ a: 'pl: Cześć, Ada!', b: 'pl: Cześć, Olek!' });
    expect(res.headers['content-language']).toBe('pl');
    expect(resolver.calls - before).toBe(1);
  });

  it('keeps ?lang above the saved language', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql?lang=de')
      .set('authorization', 'Bearer 1')
      .send({ query: '{ greeting(name: "Ada") }' })
      .expect(200);

    expect(res.body.data).toEqual({ greeting: 'de: Hallo, Ada!' });
  });
});

describe('WebSocket gateways (ws): the saved locale after the guard', () => {
  @WebSocketGateway({ path: '/ws' })
  @UseGuards(AuthGuard)
  class GreetingGateway implements OnGatewayConnection {
    constructor(private readonly i18nService: I18nService<AppTranslations>) {}

    handleConnection(client: WebSocket & { request?: IncomingMessage }, request: IncomingMessage) {
      client.request = request;
    }

    @SubscribeMessage('greet')
    greet(_client: WebSocket, data: { name: string }) {
      return { event: 'greeting', data: this.i18nService.t('users.greeting', { args: { name: data.name } }) };
    }
  }

  @Module({
    imports: [i18nModule()],
    providers: [AuthGuard, GreetingGateway],
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

  const greet = async (path: string, headers: Record<string, string>) => {
    const socket = new WebSocket(base + path, { headers });
    sockets.push(socket);
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    const reply = new Promise<string>((resolve) => socket.once('message', (raw) => resolve(String(raw))));
    socket.send(JSON.stringify({ event: 'greet', data: { name: 'Ada' } }));
    return JSON.parse(await reply).data as string;
  };

  it('ranks the saved language between ?lang and Accept-Language', async () => {
    expect(await greet('', { authorization: 'Bearer 1', 'accept-language': 'de' })).toBe('Cześć, Ada!');
    expect(await greet('?lang=de', { authorization: 'Bearer 1' })).toBe('Hallo, Ada!');
    expect(await greet('', { authorization: 'Bearer 3', 'accept-language': 'de' })).toBe('Hallo, Ada!');
  });
});

describe('microservices (TCP): the saved locale after the guard', () => {
  @Controller()
  @UseGuards(AuthGuard)
  class GreetingHandlers {
    constructor(
      private readonly i18nService: I18nService<AppTranslations>,
      private readonly i18nContext: I18nContext,
    ) {}

    @MessagePattern('greet')
    greet(@Payload() data: { name: string; locale?: string }, @CurrentLocale() locale: string) {
      if (data.locale) {
        this.i18nContext.setLocale(data.locale);
      }
      return { locale, message: this.i18nService.t('users.greeting', { args: { name: data.name } }) };
    }
  }

  @Module({
    imports: [
      i18nModule([CustomerLocaleResolver]),
    ],
    controllers: [GreetingHandlers],
    providers: [AuthGuard],
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

  const send = (data: object) => firstValueFrom(client.send<{ locale: string; message: string }>('greet', data));

  it('reads the user the guard put on the message context', async () => {
    expect(await send({ name: 'Ada', token: 'Bearer 1' })).toEqual({ locale: 'pl', message: 'Cześć, Ada!' });
    expect(await send({ name: 'Ada', token: 'Bearer 2' })).toEqual({ locale: 'de', message: 'Hallo, Ada!' });
    expect(await send({ name: 'Ada' })).toEqual({ locale: 'en', message: 'Hello, Ada!' });
  });

  it('setLocale() works in the handler', async () => {
    expect(await send({ name: 'Ada', token: 'Bearer 1', locale: 'de' })).toEqual({
      locale: 'pl',
      message: 'Hallo, Ada!',
    });
  });
});
