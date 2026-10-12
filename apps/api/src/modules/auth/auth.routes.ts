import { Router, type CookieOptions, type Response } from 'express';
import { cookieSecure } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { LoginBodySchema, RegisterBodySchema } from './auth.schemas.js';
import * as authService from './auth.service.js';

export const REFRESH_COOKIE = 'tf_refresh';

const cookieBase: CookieOptions = { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/auth' };

function sendSession(res: Response, status: number, session: authService.Session, user?: authService.PublicUser): void {
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...cookieBase, expires: session.refreshTokenExpiresAt });
  res.status(status).json({
    ...(user ? { user } : {}),
    accessToken: session.accessToken,
    expiresIn: session.accessTokenExpiresIn,
  });
}

function refreshCookie(cookies: unknown): string | undefined {
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value: unknown = (cookies as Record<string, unknown>)[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const { user, session } = await authService.register(parse(RegisterBodySchema, req.body));
  sendSession(res, 201, session, user);
});

authRouter.post('/login', async (req, res) => {
  const { user, session } = await authService.login(parse(LoginBodySchema, req.body));
  sendSession(res, 200, session, user);
});

authRouter.post('/refresh', async (req, res) => {
  const session = await authService.refresh(refreshCookie(req.cookies));
  sendSession(res, 200, session);
});

authRouter.post('/logout', async (req, res) => {
  await authService.logout(refreshCookie(req.cookies));
  res.clearCookie(REFRESH_COOKIE, cookieBase);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json({ user: await authService.getProfile(currentUser(req).id) });
});
