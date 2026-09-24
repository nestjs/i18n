import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import {
  ForbiddenException,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  UseGuards,
  type CanActivate,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import { Args, GraphQLModule, Parent, Query, ResolveField, Resolver, Subscription } from '@nestjs/graphql';
import { createClient } from 'graphql-ws';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createApp } from './support/adapters.js';
import {
  AcceptLanguageLocaleResolver,
  CurrentLocale,
  HeaderLocaleResolver,
  I18nModule,
  I18nService,
  JsonI18nLoader,
  QueryLocaleResolver,
  t,
} from '../lib/index.js';
import { localesPath, type AppTranslations } from './app.js';

const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    locale: String
    greeting: String!
    apples(count: Int!): String!
  }
  type Query {
    user(id: ID!): User
    missingUser(id: ID!): User
    guarded: String
  }
`;

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException(t('users.forbidden'));
  }
}

const tick = () => new Promise((r) => setTimeout(r, Math.random() * 10));

@Resolver('User')
class UsersResolver {
  constructor(private readonly i18n: I18nService<AppTranslations>) {}

  @Query('user')
  async user(@Args('id') id: string, @CurrentLocale() locale: string) {
    await tick();
    return { id, locale };
  }

  @Query('missingUser')
  missingUser(@Args('id') id: string) {
    throw new NotFoundException(t('users.notFound', { args: { id } }));
  }

  @Query('guarded')
  @UseGuards(DenyGuard)
  guarded() {
    return 'unreachable';
  }

  @ResolveField('greeting')
  async greeting(@Parent() user: { id: string }) {
    await tick();
    return this.i18n.t('users.greeting', { args: { name: user.id } });
  }

  @ResolveField('apples')
  apples(@Args('count') count: number) {
    return this.i18n.t('users.apples', { args: { count } });
  }
}

function appModule(fieldResolverEnhancers: ApolloDriverConfig['fieldResolverEnhancers']): DynamicModule {
  @Module({})
  class GqlAppModule {}
  return {
    module: GqlAppModule,
    imports: [
      I18nModule.forRoot({
        defaultLocale: 'en',
        loader: new JsonI18nLoader({ path: localesPath }),
        resolvers: [
          new QueryLocaleResolver('lang'),
          new HeaderLocaleResolver('x-lang'),
          new AcceptLanguageLocaleResolver(),
        ],
      }),
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        typeDefs,
        context: ({ req }: { req: unknown }) => ({ req }),
        fieldResolverEnhancers,
      }),
    ],
    providers: [UsersResolver, DenyGuard],
  };
}

const USER = `query($id: ID!) { user(id: $id) { id locale greeting apples(count: 5) } }`;

describe('GraphQL (Apollo, express) over HTTP: the middleware wraps every operation', () => {
  let app: INestApplication;
  const gql = (query: string, variables: object, lang?: string) => {
    const req = request(app.getHttpServer()).post('/graphql');
    if (lang) {
      req.set('accept-language', lang);
    }
    return req.send({ query, variables });
  };

  beforeAll(async () => {
    // No field resolver enhancers: the middleware alone covers field resolvers.
    app = await createApp('express', appModule([]) as any);
  });
  afterAll(() => app.close());

  it('resolves the locale from the request headers; @CurrentLocale() and t() in resolvers and field resolvers', async () => {
    const res = await gql(USER, { id: 'Ada' }, 'pl-PL').expect(200);
    expect(res.body.data.user).toEqual({
      id: 'Ada',
      locale: 'pl',
      greeting: 'Cześć, Ada!',
      apples: '5 jabłek',
    });
    const en = await gql(USER, { id: 'Ada' });
    expect(en.body.data.user).toEqual({ id: 'Ada', locale: 'en', greeting: 'Hello, Ada!', apples: '5 apples' });
  });

  it('translates exceptions thrown in resolvers', async () => {
    const res = await gql(`query { missingUser(id: "9") { id } }`, {}, 'de');
    expect(res.body.errors[0].message).toBe('Benutzer #9 wurde nicht gefunden');
  });

  it('translates exceptions thrown in guards', async () => {
    const res = await gql(`query { guarded }`, {}, 'pl');
    expect(res.body.errors[0].message).toBe('Nie masz dostępu do tego zasobu');
  });

  it('does not bleed locales between concurrent operations', async () => {
    const langs = ['pl', 'de', 'en', 'pl', 'de', 'en', 'pl', 'de'];
    const greetings: Record<string, string> = { pl: 'Cześć, X!', de: 'Hallo, X!', en: 'Hello, X!' };
    const responses = await Promise.all(langs.map((l) => gql(USER, { id: 'X' }, l)));
    responses.forEach((res, i) => {
      expect(res.body.data.user.locale).toBe(langs[i]);
      expect(res.body.data.user.greeting).toBe(greetings[langs[i]]);
    });
  });
});

describe('GraphQL outside the HTTP middleware (subscriptions, drivers mounted before it)', () => {
  let app: INestApplication;
  // Executes the operation in Apollo directly, so no HTTP middleware runs.
  const execute = async (query: string, lang: string) => {
    const apollo = app.get<GraphQLModule<ApolloDriver>>(GraphQLModule).graphQlAdapter.instance;
    const { body } = await apollo.executeOperation(
      { query, variables: { id: 'Ada' } },
      { contextValue: { req: { headers: { 'accept-language': lang }, query: {} } } },
    );
    if (body.kind !== 'single') {
      throw new Error('expected a single result');
    }
    return body.singleResult as { data?: any; errors?: readonly { message: string }[] };
  };

  beforeAll(async () => {
    app = await createApp('express', appModule(['interceptors']) as any);
  });
  afterAll(() => app.close());

  it('the interceptor resolves the locale from the request on the GraphQL context', async () => {
    const res = await execute(USER, 'pl');
    expect(res.data.user).toEqual({
      id: 'Ada',
      locale: 'pl',
      greeting: 'Cześć, Ada!',
      apples: '5 jabłek',
    });
  });

  it('guards run before interceptors, so they cannot translate', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const res = await execute(`query { guarded }`, 'pl');
      expect(res.errors?.[0].message).toBe('users.forbidden');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('GraphQL subscriptions (graphql-ws): the locale of the WebSocket upgrade request', () => {
  /** One publish function per subscription, in subscription order. */
  const subscribers: ((payload: object) => void)[] = [];
  /** A minimal PubSub: one async iterator per subscription. */
  const subscribe = () => {
    const queue: object[] = [];
    let wake: (() => void) | undefined;
    subscribers.push((payload) => {
      queue.push(payload);
      wake?.();
    });
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<object>> {
        while (!queue.length) {
          await new Promise<void>((resolve) => (wake = resolve));
        }
        return { value: queue.shift()!, done: false };
      },
      async return(): Promise<IteratorResult<object>> {
        return { value: undefined, done: true };
      },
    };
  };

  @Resolver('Shipment')
  class ShipmentsResolver {
    constructor(private readonly i18n: I18nService<AppTranslations>) {}

    @Query('ping')
    ping() {
      return 'pong';
    }

    @Subscription('shipped')
    shipped(@CurrentLocale() locale: string) {
      subscribedIn.push(locale);
      return subscribe();
    }

    @ResolveField('message')
    message(@Parent() shipment: { id: string }) {
      return this.i18n.t('users.notFound', { args: { id: shipment.id } });
    }
  }

  const subscribedIn: string[] = [];

  @Module({
    imports: [
      I18nModule.forRoot({
        defaultLocale: 'en',
        loader: new JsonI18nLoader({ path: localesPath }),
        resolvers: [new QueryLocaleResolver('lang'), new AcceptLanguageLocaleResolver()],
      }),
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        typeDefs: /* GraphQL */ `
          type Shipment {
            id: ID!
            message: String!
          }
          type Query {
            ping: String
          }
          type Subscription {
            shipped: Shipment!
          }
        `,
        subscriptions: { 'graphql-ws': true },
        // Events are resolved outside the subscribing request, so field
        // resolvers need the interceptor to enter the locale.
        fieldResolverEnhancers: ['interceptors'],
      }),
    ],
    providers: [ShipmentsResolver],
  })
  class SubscriptionsAppModule {}

  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    app = await createApp('express', SubscriptionsAppModule);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/graphql`;
  });
  afterAll(() => app.close());

  const firstEvent = async (path: string, headers: Record<string, string>) => {
    class HandshakeWebSocket extends WebSocket {
      constructor(address: string, protocols?: string | string[]) {
        super(address, protocols, { headers });
      }
    }
    const client = createClient({ url: url + path, webSocketImpl: HandshakeWebSocket, retryAttempts: 0 });
    try {
      const before = subscribers.length;
      const event = new Promise((resolve, reject) => {
        client.subscribe(
          { query: 'subscription { shipped { id message } }' },
          { next: resolve, error: reject, complete: () => {} },
        );
      });
      await vi.waitFor(() => expect(subscribers.length).toBe(before + 1), { timeout: 3000, interval: 10 });
      subscribers[before]({ shipped: { id: '7' } });
      return await event;
    } finally {
      await client.dispose();
    }
  };

  it('from the handshake headers', async () => {
    expect(await firstEvent('', { 'accept-language': 'pl-PL' })).toEqual({
      data: { shipped: { id: '7', message: 'Nie znaleziono użytkownika #7' } },
    });
    expect(subscribedIn.at(-1)).toBe('pl');
  });

  it('from the handshake query', async () => {
    expect(await firstEvent('?lang=de', { 'accept-language': 'pl' })).toEqual({
      data: { shipped: { id: '7', message: 'Benutzer #7 wurde nicht gefunden' } },
    });
    expect(subscribedIn.at(-1)).toBe('de');
  });
});

describe('GraphQL with a global prefix', () => {
  // Nest mounts wildcard middleware under the global prefix (`/api/*`), and
  // Apollo's default path stays `/graphql` unless `useGlobalPrefix` is set.
  function prefixedAppModule(useGlobalPrefix: boolean): DynamicModule {
    @Module({})
    class PrefixedGqlAppModule {}
    return {
      module: PrefixedGqlAppModule,
      imports: [
        I18nModule.forRoot({
          defaultLocale: 'en',
          loader: new JsonI18nLoader({ path: localesPath }),
          resolvers: [new QueryLocaleResolver('lang'), new AcceptLanguageLocaleResolver()],
        }),
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          typeDefs,
          useGlobalPrefix,
          context: ({ req }: { req: unknown }) => ({ req }),
        }),
      ],
      providers: [UsersResolver, DenyGuard],
    };
  }

  const boot = (useGlobalPrefix: boolean) =>
    createApp('express', prefixedAppModule(useGlobalPrefix) as any, {
      setup: (app) => void app.setGlobalPrefix('api'),
    });

  it('outside the prefix, only the interceptor runs: no guard translation, no headers', async () => {
    const app = await boot(false);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const guarded = await request(app.getHttpServer())
        .post('/graphql?lang=pl')
        .send({ query: 'query { guarded }' })
        .expect(200);
      expect(guarded.body.errors[0].message).toBe('users.forbidden');
      expect(guarded.headers['content-language']).toBeUndefined();
      // the resolver itself is covered; its field resolvers aren't without enhancers
      const user = await request(app.getHttpServer())
        .post('/graphql?lang=pl')
        .send({ query: USER, variables: { id: 'Ada' } })
        .expect(200);
      expect(user.body.data.user).toEqual({
        id: 'Ada',
        locale: 'pl',
        greeting: 'Hello, Ada!',
        apples: '5 apples',
      });
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('under the prefix (useGlobalPrefix: true), the middleware wraps every operation again', async () => {
    const app = await boot(true);
    try {
      const guarded = await request(app.getHttpServer())
        .post('/api/graphql?lang=pl')
        .send({ query: 'query { guarded }' })
        .expect(200);
      expect(guarded.body.errors[0].message).toBe('Nie masz dostępu do tego zasobu');
      expect(guarded.headers['content-language']).toBe('pl');
      const user = await request(app.getHttpServer())
        .post('/api/graphql?lang=pl')
        .send({ query: USER, variables: { id: 'Ada' } })
        .expect(200);
      expect(user.body.data.user).toEqual({
        id: 'Ada',
        locale: 'pl',
        greeting: 'Cześć, Ada!',
        apples: '5 jabłek',
      });
    } finally {
      await app.close();
    }
  });
});
