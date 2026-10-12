import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { useTestServer } from './helpers.js';

const { url } = useTestServer();

function refreshCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown;
  const cookies = Array.isArray(raw) ? (raw as string[]) : [];
  const cookie = cookies.find((c) => c.startsWith('tf_refresh='));
  if (!cookie) throw new Error('no refresh cookie set');
  return cookie.split(';')[0] ?? '';
}

async function register(email = 'alice@example.com', role?: string) {
  return request(url()).post('/auth/register').send({ email, password: 'correct-horse', ...(role ? { role } : {}) });
}

describe('auth', () => {
  it('registers a user, returns an access token and sets an httpOnly refresh cookie', async () => {
    const res = await register('Alice@Example.com');
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com', role: 'attendee' });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('user.passwordHash');
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('tf_refresh='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('rejects duplicate emails, invalid input and self-registration as admin', async () => {
    await register();
    expect((await register()).status).toBe(409);
    expect((await register('not-an-email')).status).toBe(400);
    const admin = await register('mallory@example.com', 'admin');
    expect(admin.status).toBe(400);
    expect(admin.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in with correct credentials only', async () => {
    await register();
    const bad = await request(url()).post('/auth/login').send({ email: 'alice@example.com', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    const unknown = await request(url()).post('/auth/login').send({ email: 'nobody@example.com', password: 'whatever1' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe(bad.body.error.code);

    const ok = await request(url()).post('/auth/login').send({ email: 'alice@example.com', password: 'correct-horse' });
    expect(ok.status).toBe(200);
    const me = await request(url()).get('/auth/me').set('Authorization', `Bearer ${ok.body.accessToken as string}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@example.com');
  });

  it('requires a valid bearer token', async () => {
    expect((await request(url()).get('/auth/me')).status).toBe(401);
    const res = await request(url()).get('/auth/me').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it('rotates refresh tokens and revokes the whole family when a rotated token is reused', async () => {
    const reg = await register();
    const first = refreshCookieFrom(reg);

    const r1 = await request(url()).post('/auth/refresh').set('Cookie', first);
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toEqual(expect.any(String));
    const second = refreshCookieFrom(r1);
    expect(second).not.toBe(first);

    // Replaying the rotated token looks like theft: it fails and kills the family...
    const replay = await request(url()).post('/auth/refresh').set('Cookie', first);
    expect(replay.status).toBe(401);
    // ...so the legitimate newer token is revoked too.
    const afterTheft = await request(url()).post('/auth/refresh').set('Cookie', second);
    expect(afterTheft.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const cookie = refreshCookieFrom(await register());
    expect((await request(url()).post('/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(url()).post('/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });

  it('enforces RBAC: attendees cannot create events', async () => {
    const reg = await register();
    const res = await request(url())
      .post('/events')
      .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
      .send({ title: 'x', venue: 'y', startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(res.status).toBe(403);
  });
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await request(url()).get('/health/live')).status).toBe(200);
    const ready = await request(url()).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres).toBe('ok');
  });

  it('propagates a well-formed x-request-id', async () => {
    const res = await request(url()).get('/health/live').set('x-request-id', 'req-abc-123');
    expect(res.headers['x-request-id']).toBe('req-abc-123');
  });
});
