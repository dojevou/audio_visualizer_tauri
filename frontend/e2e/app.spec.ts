import { test, expect } from '@playwright/test';

test.describe('Audio Visualizer E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('has correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/Audio Visualizer/);
  });

  test('displays header', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Audio Visualizer - Forensic Analysis');
  });

  test('has open audio button', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Open Audio File' });
    await expect(button).toBeVisible();
  });

  test('has frequency input', async ({ page }) => {
    const input = page.getByRole('spinbutton');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('8000');
  });

  test('displays audio info section', async ({ page }) => {
    await expect(page.getByText('Audio Info')).toBeVisible();
    await expect(page.getByText('No file loaded')).toBeVisible();
  });

  test('displays forensic analysis section', async ({ page }) => {
    await expect(page.getByText('Forensic Analysis')).toBeVisible();
    await expect(page.getByText('Load audio to analyze')).toBeVisible();
  });

  test('has canvas element', async ({ page }) => {
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('shows placeholder message', async ({ page }) => {
    await expect(page.getByText('Load an audio file to view spectrogram')).toBeVisible();
  });

  test('frequency input accepts values', async ({ page }) => {
    const input = page.getByRole('spinbutton');
    await input.fill('16000');
    await expect(input).toHaveValue('16000');
  });
});
