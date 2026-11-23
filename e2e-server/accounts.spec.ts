import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Journeys on the real server. Each person creates an account on the screens
 * the app shows, and what they add is checked on the server itself.
 */

const unique = (label: string) => `${label}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`;
const PASSWORD = 'a-long-password';

async function createAccount(page: Page, name: string, email: string, password = PASSWORD) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await page.locator('input[name=name]').fill(name);
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.locator('button.connect-submit').click();
  // The welcome steps appear once; skip them to reach the week.
  await page.getByRole('button', { name: 'Skip setup' }).click({ timeout: 20_000 });
  await dismissFirstRun(page);
  await expect(page.getByRole('button', { name: 'Add task', exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * The one-time notices a new account is shown, one above another. Each is a
 * dialog with a way to say it has been read; they are closed from the top down
 * until none is left, waiting briefly in case another is about to appear.
 */
async function dismissFirstRun(page: Page) {
  let quietSince = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const dialog = page.getByRole('dialog').last();
    const closer = dialog.getByRole('button', { name: /^(Save this choice|Not now|Close)$/ }).first();
    if (await closer.isVisible({ timeout: 300 }).catch(() => false)) {
      await closer.click();
      quietSince = 0;
      continue;
    }
    if (!quietSince) quietSince = Date.now();
    if (Date.now() - quietSince > 1_500) return;
    await page.waitForTimeout(200);
  }
}

/** The account menu in the sidebar: the one that shows this person’s address. */
const accountButton = (page: Page, email: string) => page.locator('button').filter({ hasText: email }).first();

const tokenOf = (page: Page) => page.evaluate(() => localStorage.getItem('tde.session'));

async function serverItems(request: APIRequestContext, base: string, token: string) {
  const reply = await request.post(`${base}/api/v1/sync`, {
    headers: { Authorization: `Bearer ${token}` },
    form: { sync_token: '*', resource_types: JSON.stringify(['items']) },
  });
  expect(reply.status()).toBe(200);
  return (await reply.json()).items as Array<{ content: string; priority: number; due: { date: string } | null; labels: string[] }>;
}

async function addTask(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add task', exact: true }).first().click();
  const field = page.locator('textarea.composer-name');
  await field.fill(text);
  await field.press('Control+Enter');
  await expect(field).toHaveCount(0, { timeout: 10_000 });
}

test('a new person creates an account, and stays signed in across a reload', async ({ page }) => {
  await createAccount(page, 'Ada Tester', unique('ada'));
  const token = await tokenOf(page);
  expect(token).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add task', exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(await tokenOf(page)).toBe(token);
});

test('a task added in the app is stored on the server, and still there after a reload', async ({ page, request, baseURL }) => {
  await createAccount(page, 'Grace Tester', unique('grace'));
  const token = (await tokenOf(page))!;
  await addTask(page, 'Write the report tomorrow p1 #Inbox @week');
  await expect.poll(async () => (await serverItems(request, baseURL!, token)).map((i) => i.content), { timeout: 15_000 })
    .toContain('Write the report');
  const stored = (await serverItems(request, baseURL!, token)).find((i) => i.content === 'Write the report')!;
  expect(stored.priority).toBe(4);
  expect(stored.labels).toEqual(['week']);
  expect(stored.due).not.toBeNull();
  await page.reload();
  await dismissFirstRun(page);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.getByText('Write the report').first()).toBeVisible({ timeout: 20_000 });
});

test('signing out ends the session on the server; signing in again brings the account back', async ({ page, request, baseURL }) => {
  const email = unique('sam');
  await createAccount(page, 'Sam Tester', email);
  await addTask(page, 'Keep this across sign-outs');
  const oldToken = (await tokenOf(page))!;
  await expect.poll(async () => (await serverItems(request, baseURL!, oldToken)).length, { timeout: 15_000 }).toBeGreaterThan(0);

  await accountButton(page, email).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('button.connect-submit')).toBeVisible({ timeout: 15_000 });
  expect(await tokenOf(page)).toBeNull();

  // The token that was on this device no longer works anywhere.
  const revoked = await request.get(`${baseURL}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${oldToken}` } });
  expect(revoked.status()).toBe(401);

  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('button.connect-submit').click();
  await expect(page.getByRole('button', { name: 'Add task', exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await dismissFirstRun(page);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.getByText('Keep this across sign-outs').first()).toBeVisible({ timeout: 20_000 });
});

test('a wrong password and an unknown address get the same answer; an address in use is refused', async ({ page }) => {
  const email = unique('taken');
  await createAccount(page, 'Taken Tester', email);
  await accountButton(page, email).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('button.connect-submit')).toBeVisible({ timeout: 15_000 });

  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill('the wrong password');
  await page.locator('button.connect-submit').click();
  const wrong = page.getByRole('alert').filter({ hasText: 'do not match an account' });
  await expect(wrong).toBeVisible();

  await page.locator('input[name=email]').fill(unique('nobody'));
  await page.locator('button.connect-submit').click();
  await expect(wrong).toBeVisible();

  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('button.connect-submit').click();
  await expect(page.getByRole('alert').filter({ hasText: 'already uses that email address' })).toBeVisible();
});

test('a change made offline waits on the device and is sent when the connection comes back', async ({ page, context, request, baseURL }) => {
  await createAccount(page, 'Offline Tester', unique('offline'));
  const token = (await tokenOf(page))!;
  await page.getByRole('button', { name: /^Inbox/ }).click();
  // The composer's code is fetched the first time it opens. Open it once while
  // online, so the app can still open it offline (a service worker does this in a real browser).
  await page.getByRole('button', { name: 'Add task', exact: true }).first().click();
  await expect(page.locator('textarea.composer-name')).toBeVisible();
  await page.keyboard.press('Escape');
  await context.setOffline(true);
  await addTask(page, 'Written on the train');
  // It shows on the device at once, although the server cannot be reached.
  await expect(page.getByText('Written on the train').first()).toBeVisible({ timeout: 10_000 });
  expect((await serverItems(request, baseURL!, token)).map((i) => i.content)).not.toContain('Written on the train');

  await context.setOffline(false);
  await expect.poll(async () => (await serverItems(request, baseURL!, token)).map((i) => i.content), { timeout: 30_000 })
    .toContain('Written on the train');
});

test('one person never sees another person’s tasks', async ({ browser, baseURL, request }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  try {
    const a = await first.newPage();
    await createAccount(a, 'Private A', unique('privateA'));
    await addTask(a, 'Only for A');
    const tokenA = (await tokenOf(a))!;
    await expect.poll(async () => (await serverItems(request, baseURL!, tokenA)).map((i) => i.content), { timeout: 15_000 }).toContain('Only for A');

    const b = await second.newPage();
    await createAccount(b, 'Private B', unique('privateB'));
    await expect(b.getByText('Only for A')).toHaveCount(0);
    const tokenB = (await tokenOf(b))!;
    expect((await serverItems(request, baseURL!, tokenB)).map((i) => i.content)).not.toContain('Only for A');
  } finally {
    await first.close();
    await second.close();
  }
});
