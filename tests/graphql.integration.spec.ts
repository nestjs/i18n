import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module, NotFoundException, type INestApplication } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import {
  Args,
  Field,
  Float,
  GraphQLModule,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { IsEmail, MinLength } from 'class-validator';
import request from 'supertest';
import { createApp } from './support/adapters.js';
import {
  AcceptLanguageLocaleResolver,
  CurrentLocale,
  I18nModule,
  I18nService,
  I18nValidationPipe,
  InMemoryI18nLoader,
  QueryLocaleResolver,
  t,
} from '../lib/index.js';

const catalogs = {
  en: {
    orders: { status: { shipped: 'Shipped' }, notFound: 'Order #{id} was not found.', welcome: 'Welcome, {name}!' },
    validation: {
      isEmail: '{property} must be a valid email address',
      minLength: '{path} must be at least {constraint1} characters long',
    },
  },
  pl: {
    orders: { status: { shipped: 'Wysłane' }, notFound: 'Nie znaleziono zamówienia #{id}.', welcome: 'Witaj, {name}!' },
    validation: {
      isEmail: '{property} musi być poprawnym adresem e-mail',
      minLength: '{path} musi mieć co najmniej {constraint1} znaki',
    },
  },
};

@ObjectType('Order')
class OrderModel {
  @Field(() => Int)
  id: number;

  @Field()
  status: string;

  @Field(() => Float)
  total: number;
}

@ObjectType('Customer')
class CustomerModel {
  @Field()
  email: string;

  @Field()
  welcome: string;

  @Field()
  locale: string;
}

@InputType()
class CreateCustomerInput {
  @Field()
  @IsEmail()
  email: string;

  @Field()
  @MinLength(3)
  name: string;
}

@Resolver(() => OrderModel)
class OrdersResolver {
  constructor(private readonly i18nService: I18nService) {}

  @Query(() => OrderModel)
  order(@Args('id', { type: () => Int }) id: number) {
    if (id !== 1001) {
      throw new NotFoundException(t('orders.notFound', { args: { id } }));
    }
    return { id, status: 'shipped', total: 119.95 };
  }

  @ResolveField(() => String)
  statusLabel(@Parent() order: OrderModel) {
    return this.i18nService.translate(`orders.status.${order.status}`);
  }

  @ResolveField(() => String)
  formattedTotal(@Parent() order: OrderModel) {
    return this.i18nService.formatNumber(order.total, { style: 'currency', currency: 'EUR' });
  }

  @Mutation(() => CustomerModel)
  createCustomer(@Args('input') input: CreateCustomerInput, @CurrentLocale() locale: string) {
    return {
      email: input.email,
      welcome: this.i18nService.translate('orders.welcome', { args: { name: input.name } }),
      locale,
    };
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      loader: new InMemoryI18nLoader(catalogs),
      resolvers: [new QueryLocaleResolver('lang'), new AcceptLanguageLocaleResolver()],
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true }),
  ],
  providers: [OrdersResolver, { provide: APP_PIPE, useValue: new I18nValidationPipe() }],
})
class CodeFirstAppModule {}

describe('GraphQL, code first (Apollo, express): the tutorial app shape', () => {
  let app: INestApplication;
  const gql = (query: string, path = '/graphql') => request(app.getHttpServer()).post(path).send({ query });

  beforeAll(async () => {
    app = await createApp('express', CodeFirstAppModule);
  });
  afterAll(() => app.close());

  const ORDER = '{ order(id: 1001) { id statusLabel formattedTotal } }';

  it('localizes field resolvers and formatting, and sets Content-Language and Vary', async () => {
    const res = await gql(ORDER, '/graphql?lang=pl').expect(200);

    expect(res.body).toEqual({ data: { order: { id: 1001, statusLabel: 'Wysłane', formattedTotal: '119,95 €' } } });
    expect(res.headers['content-language']).toBe('pl');
    expect(res.headers['vary']).toBe('Accept-Language');
  });

  it('translates exceptions from resolvers', async () => {
    const res = await gql('{ order(id: 7) { id } }').set('accept-language', 'pl-PL').expect(200);

    expect(res.body.errors[0].message).toBe('Nie znaleziono zamówienia #7.');
  });

  it('translates validation messages of mutation input with the global I18nValidationPipe', async () => {
    const res = await gql('mutation { createCustomer(input: { email: "nope", name: "Al" }) { email } }')
      .set('accept-language', 'pl')
      .expect(200);

    expect(res.body.errors[0].extensions.originalError.message).toEqual([
      'email musi być poprawnym adresem e-mail',
      'name musi mieć co najmniej 3 znaki',
    ]);
  });

  it('runs a valid mutation in the request locale', async () => {
    const res = await gql('mutation { createCustomer(input: { email: "ada@example.com", name: "Ada" }) { email welcome locale } }')
      .set('accept-language', 'pl')
      .expect(200);

    expect(res.body.data.createCustomer).toEqual({ email: 'ada@example.com', welcome: 'Witaj, Ada!', locale: 'pl' });
  });
});
