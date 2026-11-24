import { expect, test, type Page } from '@playwright/test';

/**
 * Workspaces made and used in Settings, on the real server: an owner makes a
 * workspace and a folder, invites a person who has no account yet, and that
 * person accepts from their notifications.
 */

const PASSWORD = 'a-long-password';
const unique = (label: string) => `${label}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`;

async function dismissFirstRun(page: Page) {
  let quietSince = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const dialog = page.getByRole('dialog').last();
    const closer = dialog.getByRole('button', { name: /^(Save this choice|Not now|Close|Skip setup)$/ }).first();
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

async function createAccount(page: Page, name: string, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await page.locator('input[name=name]').fill(name);
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('button.connect-submit').click();
  await page.getByRole('button', { name: 'Skip setup' }).click({ timeout: 20_000 });
  await dismissFirstRun(page);
  await expect(page.getByRole('button', { name: 'Add task', exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

test('a workspace made in Settings takes in members by email, and a folder is added to it', async ({ browser, baseURL }) => {
  // Two accounts are made on the screens, each with its first-run notices, before the workspace is used.
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL });
  const guest = await browser.newContext({ baseURL });
  try {
    const page = await owner.newPage();
    const guestEmail = unique('member');
    // The invitee needs an account at the address first.
    const made = await guest.request.post(`${baseURL}/api/v1/auth/register`, { data: { email: guestEmail, password: PASSWORD, full_name: 'Gina Guest' } });
    expect(made.status()).toBe(201);
    await createAccount(page, 'Wendy Workspace', unique('wendy'));

    await page.goto('/#/settings');
    await page.getByLabel('Workspace name').fill('Studio team');
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Studio team', level: 3 })).toBeVisible({ timeout: 20_000 });

    await page.getByPlaceholder('Invite by email').fill(guestEmail);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(page.getByPlaceholder('Invite by email')).toHaveValue('', { timeout: 20_000 });

    await page.getByPlaceholder('New folder name').fill('Clients');
    await page.getByRole('button', { name: 'Add folder', exact: true }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Clients' }).first()).toBeVisible({ timeout: 20_000 });

    // The person invited signs in, and accepts from the bell.
    const invited = await guest.newPage();
    await invited.goto('/');
    await invited.locator('input[name=email]').fill(guestEmail);
    await invited.locator('input[name=password]').fill(PASSWORD);
    await invited.locator('button.connect-submit').click();
    await invited.getByRole('button', { name: 'Add task', exact: true }).first().waitFor({ timeout: 20_000 });
    await dismissFirstRun(invited);
    await invited.getByRole('button', { name: 'Notifications', exact: true }).click();
    const bell = invited.getByRole('dialog', { name: 'Notifications' });
    await bell.getByRole('button', { name: 'Accept', exact: true }).click();

    await invited.goto('/#/settings');
    await expect(invited.getByRole('heading', { name: 'Studio team', level: 3 })).toBeVisible({ timeout: 20_000 });
  } finally {
    await owner.close();
    await guest.close();
  }
});
