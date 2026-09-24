import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonI18nLoader } from '../lib/index.js';

describe('JsonI18nLoader', () => {
  let dir: string;
  const write = async (path: string, content: unknown) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const load = () => new JsonI18nLoader({ path: dir }).load();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nest-i18n-loader-'));
    await write('en/users.json', { hi: 'Hi' });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('nests sub-directories as namespaces', async () => {
    await write('en/admin/audit.json', { title: 'Audit log' });
    expect(await load()).toEqual({ en: { users: { hi: 'Hi' }, admin: { audit: { title: 'Audit log' } } } });
  });

  it('follows symbolic links to locale directories, namespaces and files', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'nest-i18n-shared-'));
    try {
      await writeFile(join(shared, 'common.json'), JSON.stringify({ ok: 'OK' }));
      await symlink(join(dir, 'en'), join(dir, 'en-GB'));
      await symlink(shared, join(dir, 'en', 'shared'));
      await symlink(join(shared, 'common.json'), join(dir, 'en', 'common.json'));
      const expected = { users: { hi: 'Hi' }, shared: { common: { ok: 'OK' } }, common: { ok: 'OK' } };
      expect(await load()).toEqual({ en: expected, 'en-GB': expected });
    } finally {
      await rm(shared, { recursive: true, force: true });
    }
  });

  it('fails on a directory that links back to itself, naming it', async () => {
    await symlink(join(dir, 'en'), join(dir, 'en', 'loop'));
    await expect(load()).rejects.toThrow(`${join(dir, 'en', 'loop')}: symbolic link cycle`);
  });

  it('skips hidden entries: editor lock files, macOS metadata, ConfigMap internals', async () => {
    // Emacs marks a file being edited with a dangling symlink named .#<file>
    await symlink('user@host.1234:1700000000', join(dir, 'en', '.#users.json'));
    // macOS writes AppleDouble files into archives and onto non-HFS volumes
    await write('en/._users.json', '\u0000\u0005\u0016\u0007');
    // Kubernetes mounts ConfigMaps with ..data and timestamped directories
    await write('en/..2026_09_22_10_00_00.000/users.json', { hi: 'stale' });
    await symlink(join(dir, 'en', '..2026_09_22_10_00_00.000'), join(dir, 'en', '..data'));
    await write('.git/HEAD.json', { ref: 'main' });
    expect(await load()).toEqual({ en: { users: { hi: 'Hi' } } });
  });

  it('says how to ship the catalogs when the directory is missing', async () => {
    const path = join(dir, 'dist', 'i18n');
    await expect(new JsonI18nLoader({ path }).load()).rejects.toThrow(
      `JsonI18nLoader: the catalog directory ${path} doesn't exist (ENOENT). ` +
        'When it is in the build output, list the catalogs in the "assets" of nest-cli.json.',
    );
  });

  it('names the file that fails to parse', async () => {
    await write('en/orders.json', '{ "title": ');
    await expect(load()).rejects.toThrow(join(dir, 'en', 'orders.json'));
  });

  it('keeps a file named like an Object.prototype key as a namespace', async () => {
    await write('en/__proto__.json', { polluted: 'yes' });
    const catalogs = await load();
    expect(Object.keys(catalogs.en).sort()).toEqual(['__proto__', 'users']);
    expect((catalogs.en as Record<string, unknown>).polluted).toBeUndefined();
  });
});
