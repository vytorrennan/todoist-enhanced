import { apiUrl } from './client';
import type { TodoistUser } from '@/domain/types';

/**
 * Signing in and creating an account. These are the only calls made before
 * there is a session, so they carry no token and do not go through `request`.
 */

export interface SignedIn {
  token: string;
  user: TodoistUser;
}

/** Why an account could not be opened, in words the sign-in screen can show. */
export type AccountProblem =
  | 'invalid-credentials'
  | 'email-taken'
  | 'weak-password'
  | 'invalid-email'
  | 'too-many-attempts'
  | 'signup-closed'
  | 'offline'
  | 'server';

export interface AccountFailure {
  problem: AccountProblem;
  retryAfter?: number;
}

const TIMEOUT_MS = 20_000;

async function post(path: string, body: unknown): Promise<Response | AccountFailure> {
  try {
    return await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { problem: 'offline' };
  }
}

function problemOf(status: number, tag: string | undefined): AccountProblem {
  if (status === 429) return 'too-many-attempts';
  if (status === 401) return 'invalid-credentials';
  if (status === 403 && tag === 'SIGNUP_CLOSED') return 'signup-closed';
  if (status === 409) return 'email-taken';
  if (tag === 'WEAK_PASSWORD') return 'weak-password';
  if (tag === 'INVALID_EMAIL') return 'invalid-email';
  return 'server';
}

async function signedIn(response: Response): Promise<SignedIn | AccountFailure> {
  const body = await response.json().catch(() => ({})) as { token?: string; user?: TodoistUser; error_tag?: string };
  if (response.ok && body.token && body.user) return { token: body.token, user: body.user };
  const retry = Number(response.headers.get('retry-after'));
  return {
    problem: problemOf(response.status, body.error_tag),
    ...(response.status === 429 && retry > 0 ? { retryAfter: retry } : {}),
  };
}

export const isFailure = (value: SignedIn | AccountFailure): value is AccountFailure => 'problem' in value;

export async function signInWithPassword(email: string, password: string): Promise<SignedIn | AccountFailure> {
  const response = await post('/auth/login', { email, password });
  if (!(response instanceof Response)) return response;
  return signedIn(response);
}

export async function createAccount(input: {
  email: string; password: string; fullName: string; timezone: string; lang: 'en' | 'fr';
}): Promise<SignedIn | AccountFailure> {
  const response = await post('/auth/register', {
    email: input.email,
    password: input.password,
    full_name: input.fullName,
    timezone: input.timezone,
    lang: input.lang,
  });
  if (!(response instanceof Response)) return response;
  return signedIn(response);
}
