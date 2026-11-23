import { expect, test, type Page } from '@playwright/test';

/**
 * Sharing across real accounts. The owner is set up through the API (so the
 * journey starts at the moment it matters); the invited person creates an
 * account on the screens, then accepts the invitation there.
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

test('an invitation is waiting in the bell for the account at that address, and accepting it brings the project in', async ({ page, request, baseURL }) => {
  const ownerEmail = unique('owner');
  const guestEmail = unique('guest');
  const api = async (token: string | null, path: string, body?: unknown) => request.fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    data: body ?? {},
  });
  /** A full read of what this person can see: the sync endpoint is a form post. */
  const read = (token: string | null) => request.fetch(`${baseURL}/api/v1/sync`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({ sync_token: '*', resource_types: '["projects","collaborator_states"]' }).toString(),
  }).then((r) => r.json());

  // The invitee needs an account at the address before anything can be sent to it.
  expect((await api(null, '/api/v1/auth/register', { email: guestEmail, password: PASSWORD, full_name: 'Gus Guest' })).status()).toBe(201);
  // The owner, made through the API, shares a project with that account.
  const owner = await (await api(null, '/api/v1/auth/register', { email: ownerEmail, password: PASSWORD, full_name: 'Olivia Owner' })).json();
  const ownerToken: string = owner.token;
  const shareCommand = { type: 'project_add', uuid: 'share-project-uuid-0001', args: { name: 'Shared garden' }, temp_id: '00000000-0000-4000-8000-000000000001' };
  const form = new URLSearchParams({ sync_token: '*', resource_types: '["projects"]', commands: JSON.stringify([shareCommand]) });
  const added = await request.fetch(`${baseURL}/api/v1/sync`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/x-www-form-urlencoded' }, data: form.toString(),
  });
  const projectId = (await added.json()).temp_id_mapping['00000000-0000-4000-8000-000000000001'] as string;
  const invite = new URLSearchParams({
    sync_token: '*', resource_types: '["projects"]',
    commands: JSON.stringify([{ type: 'share_project', uuid: 'share-project-uuid-0002', args: { project_id: projectId, email: guestEmail, role: 'READ_WRITE' } }]),
  });
  const sent = await request.fetch(`${baseURL}/api/v1/sync`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/x-www-form-urlencoded' }, data: invite.toString(),
  });
  expect((await sent.json()).sync_status['share-project-uuid-0002']).toBe('ok');

  // The guest signs in on the screens, and the invitation is waiting in the bell.
  await page.goto('/');
  await page.locator('input[name=email]').fill(guestEmail);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('button.connect-submit').click();
  await page.getByRole('button', { name: 'Add task', exact: true }).first().waitFor({ timeout: 20_000 });
  await dismissFirstRun(page);

  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Notifications' });
  await expect(dialog).toContainText('Olivia Owner');
  await dialog.getByRole('button', { name: 'Accept', exact: true }).click();

  // Accepted: the project is in the guest's sidebar, and the owner hears of it.
  await expect(page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: /Shared garden/ })
    .or(page.getByRole('button', { name: /Shared garden/ }).first())).toBeVisible({ timeout: 20_000 });
  const guestToken = await page.evaluate(() => localStorage.getItem('tde.session'));
  const after = await read(guestToken);
  expect(after.projects.map((p: { name: string }) => p.name)).toContain('Shared garden');
  const ownerView = await read(ownerToken);
  const states = ownerView.collaborator_states.filter((s: { project_id: string; state: string }) => s.project_id === projectId);
  expect(states.map((s: { state: string }) => s.state)).toContain('active');
});
