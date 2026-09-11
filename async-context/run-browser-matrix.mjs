#!/usr/bin/env node
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceRoot = resolve(process.argv[2] ?? 'source');
const browserName = process.env.BROWSER_NAME ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) {
  throw new Error(`unsupported browser: ${browserName}`);
}

const originalPath = join(sourceRoot, 'tests/conformance/run-browser.mjs');
const temporaryPath = join(
  sourceRoot,
  'tests/conformance',
  `.security-run-browser-${browserName}.mjs`,
);
let source = await readFile(originalPath, 'utf8');

const importNeedle = "const [{ build }, { chromium }] = await Promise.all([";
const launchNeedle = '  const browser = await chromium.launch();';
if (!source.includes(importNeedle) || !source.includes(launchNeedle)) {
  throw new Error('browser conformance driver structure drifted');
}
source = source
  .replace(
    importNeedle,
    "const [{ build }, playwright] = await Promise.all([",
  )
  .replace(
    launchNeedle,
    `  const browserType = playwright[${JSON.stringify(browserName)}];\n` +
      `  if (!browserType) throw new Error('Playwright browser not available: ${browserName}');\n` +
      '  const browser = await browserType.launch();',
  );

await writeFile(temporaryPath, source, 'utf8');
try {
  const result = spawnSync(process.execPath, [temporaryPath], {
    cwd: sourceRoot,
    env: { ...process.env, BROWSER_NAME: browserName },
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`browser context matrix passed: ${browserName}`);
} finally {
  await unlink(temporaryPath).catch(() => undefined);
}
