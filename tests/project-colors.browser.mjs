import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const css = await fs.readFile(new URL('../vendor/dream-skin/windows/assets/dream-skin.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage();
  // Codex's project drop-zone wraps artwork; its color need not be declared
  // on the SVG itself. This is the actual cascade boundary we must preserve.
  await page.setContent(`<style>:root{--ds-text:#eee;--ds-muted-rgb:140 150 160;--ds-accent:#ddab76;--ds-accent-rgb:221 171 118}.custom-icon{color:rgb(20,180,150)}</style><aside class="app-shell-left-panel"><button id="row"><span data-sidebar-project-drop-zone="project-icon" style="color:rgb(220,60,80)"><svg id="inherited" width="20" height="20"><path fill="currentColor" d="M0 0h20v20H0z"/></svg><svg class="custom-icon" id="class-color" width="20" height="20"></svg><svg id="inline" style="color:rgb(100,80,240)" width="20" height="20"></svg></span></button><button><svg id="ordinary" width="20" height="20"></svg></button></aside>`);
  const colors = () => page.evaluate(() => ['inherited', 'class-color', 'inline'].map(id => getComputedStyle(document.getElementById(id)).color));
  const expected = await colors();
  // Show that the previous generic SVG rule really loses inherited/class colors.
  const old = css.replaceAll('svg:not(:where([data-sidebar-project-drop-zone="project-icon"] *))', 'svg');
  const oldStyle = await page.addStyleTag({ content: old });
  await page.evaluate(() => document.documentElement.dataset.dreamSkin = 'active');
  assert.notDeepEqual(await colors(), expected);
  await oldStyle.evaluate(node => node.remove());
  await page.addStyleTag({ content: css });
  assert.deepEqual(await colors(), expected);
  await page.locator('#row').hover(); assert.deepEqual(await colors(), expected);
  await page.locator('#row').evaluate(node => node.setAttribute('aria-selected', 'true')); assert.deepEqual(await colors(), expected);
  await page.evaluate(() => document.documentElement.removeAttribute('data-dream-skin')); assert.deepEqual(await colors(), expected);
  await page.evaluate(() => document.documentElement.dataset.dreamSkin = 'active'); assert.deepEqual(await colors(), expected);
  console.log(JSON.stringify({ pass: true, checks: ['old-rule-reproduces-color-loss', 'inherited-class-inline-project-colors', 'hover-selected-disable-enable'] }));
} finally { await browser.close(); }
