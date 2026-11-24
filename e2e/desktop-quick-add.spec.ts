import { test, expect } from './demo';

test('inside the desktop app, Settings shows the Quick Add shortcut and no download link', async ({ demo: page }) => {
  await page.evaluate(() => {
    document.documentElement.classList.add('desktop-app');
    (window as unknown as { enhancedDesktop: unknown }).enhancedDesktop = {
      hideQuickAdd: () => {},
      getQuickAddShortcut: async () => 'Alt+Space',
      setQuickAddShortcut: async (accelerator: string) => ({ ok: true, shortcut: accelerator }),
    };
  });
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  const row = page.locator('.quickshortcut');
  await expect(row).toBeVisible();
  await expect(row.locator('.quickshortcut-field')).toHaveText('⌥Space');
  await expect(page.locator('a[href*="todoist-enhanced-desktop"]')).toHaveCount(0);
  await expect(page.locator('a[href*="releases/latest"]')).toHaveCount(0);
});

test('in the browser, Settings has no Quick Add shortcut row', async ({ demo: page }) => {
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await expect(page.locator('#about')).toBeVisible();
  await expect(page.locator('.quickshortcut')).toHaveCount(0);
});
