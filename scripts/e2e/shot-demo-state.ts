/**
 * Screenshots of the surfaces the demo-state vocabulary touches, for a human
 * look after a UI change. Not a gate: it asserts nothing, it only captures.
 *
 *   pnpm tsx --tsconfig scripts/e2e/tsconfig.json scripts/e2e/shot-demo-state.ts <businessId> <outDir>
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launch, login, newContext } from './browser.js';

const [businessId, outDir] = process.argv.slice(2);
if (!businessId || !outDir) {
  console.error('usage: shot-demo-state.ts <businessId> <outDir>');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
const browser = await launch();
try {
  const ctx = await newContext(browser, { width: 1280, height: 900 });
  const page = await login(ctx);
  for (const [name, url] of [
    ['business-header', `${base}/businesses/${encodeURIComponent(businessId)}`],
    ['inbox', `${base}/inbox`],
    ['system-by-business', `${base}/settings/system?business=${encodeURIComponent(businessId)}`],
  ] as const) {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
    console.log(`saved ${name}.png`);
  }
} finally {
  await browser.close();
}
