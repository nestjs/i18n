// class-validator is an optional peer dependency: a Zod-only app must be able
// to import the package without it.
vi.mock('class-validator', () => {
  throw new Error('class-validator is not installed');
});

describe('optional peer dependencies', () => {
  it('imports without class-validator', async () => {
    const i18n = await import('../lib/index.js');
    expect(i18n.I18nModule).toBeDefined();
    expect(i18n.I18nStandardSchemaValidationPipe).toBeDefined();
  });
});
