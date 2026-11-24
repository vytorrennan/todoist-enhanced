import { expect, test, type Page } from '@playwright/test';

/** A link to a task opens it; closing it, or going Back past it, leaves the address and the page in step. */

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

test('a task link opens its task, and closing it or going Back takes the task out of the address', async ({ page, request, baseURL }) => {
  const email = unique('linker');
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await page.locator('input[name=name]').fill('Lina Links');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('button.connect-submit').click();
  await page.getByRole('button', { name: 'Skip setup' }).click({ timeout: 20_000 });
  await dismissFirstRun(page);

  const token = (await page.evaluate(() => localStorage.getItem('tde.session')))!;
  const me = await (await request.get(`${baseURL}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const inbox = me.user.inbox_project_id as string;
  const made = await request.post(`${baseURL}/api/v1/sync`, {
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    form: { sync_token: '*', resource_types: '["items"]', commands: JSON.stringify([{ type: 'item_add', uuid: 'link-task-uuid-000001', args: { content: 'Opened by its link', project_id: inbox }, temp_id: '00000000-0000-4000-8000-0000000000aa' }]) },
  });
  const taskId = (await made.json()).temp_id_mapping['00000000-0000-4000-8000-0000000000aa'] as string;

  await page.goto(`/#/project/${inbox}?task=${taskId}`);
  const panel = page.getByRole('dialog').filter({ hasText: 'Opened by its link' }).first();
  await expect(panel).toBeVisible({ timeout: 20_000 });

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => page.url(), { timeout: 10_000 }).not.toContain('task=');

  // Opened again from the link, then Back: the address no longer names the task, so it stays closed.
  await page.goto(`/#/project/${inbox}?task=${taskId}`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await page.goBack();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
});
