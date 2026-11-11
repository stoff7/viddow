// NODE_PATH=<папка с playwright>/node_modules node tests/browser_smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { chromium } = require('playwright');

(async () => {
  const fixture = spawn('python3', ['-u', 'tests/browser_fixture.py'], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: fixture.stdout });
  let browser;
  const artifacts = process.env.VIDDOW_ARTIFACTS || path.join(os.tmpdir(), 'viddow-ui-check');
  fs.mkdirSync(artifacts, { recursive: true });
  try {
    const [line] = await Promise.race([once(lines, 'line'), once(fixture, 'exit').then(([code]) => { throw new Error(`Fixture exited: ${code}`); })]);
    const { app, source } = JSON.parse(line);
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: 'light' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app);
    await page.locator('#connection.online').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'desktop-light.png'), fullPage: true });
    assert.equal(await page.locator('#emptyState').isVisible(), true);
    await page.locator('#url').fill(source + '/video.mp4');
    await page.locator('#url').press('Enter');
    await page.locator('.job.done').waitFor();
    const saved = (await (await context.request.get(app + '/jobs')).json())[0].path;
    assert.equal(fs.readFileSync(saved).toString(), 'local-video-fixture'.repeat(4000));
    await page.getByRole('button', { name: 'Готово 1', exact: true }).click();
    assert.equal(await page.locator('.job:visible').count(), 1);
    await page.getByRole('button', { name: 'Все', exact: true }).click();

    await context.request.post(app + '/download', { data: { urls: Array(3).fill(source + '/slow.mp4') } });
    await page.reload();
    await page.locator('.job.queued').waitFor();
    assert.equal(await page.locator('.job.running').count(), 2);
    await page.locator('.job.queued').getByRole('button', { name: 'Отменить' }).click();
    await page.locator('.job.cancelled').waitFor();
    const active = await (await context.request.get(app + '/jobs')).json();
    for (const job of active.filter(job => job.status === 'running')) {
      await page.locator(`.job[data-id="${job.id}"]`).getByRole('button', { name: 'Отменить' }).click();
    }
    await page.waitForFunction(() => document.querySelectorAll('.job.cancelled').length === 3);
    await page.locator('.job.cancelled').first().getByRole('button', { name: 'Повторить' }).click();
    await page.locator('.job.running').waitFor();
    await page.locator('.job.running').getByRole('button', { name: 'Отменить' }).click();
    await page.waitForFunction(() => !document.querySelector('.job.running,.job.cancelling,.job.queued'));

    await page.locator('#url').fill(source + '/missing.mp4');
    await page.locator('#downloadButton').click();
    await page.locator('.job.error').waitFor();
    assert.match(await page.locator('.job.error .job-error').textContent(), /404/);
    await page.locator('.job.error').getByRole('button', { name: 'Повторить' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.job.error').length === 2);

    await page.getByRole('button', { name: 'Поиск в HTML', exact: true }).click();
    await page.locator('#base').fill(source + '/page');
    await page.locator('#htmlSource').fill('<title>Sample &lt;script&gt;</title><video src="/video.mp4"></video><a href="javascript:alert(1)">test</a>');
    await page.waitForFunction(() => document.querySelector('#foundCount').textContent === 'Найдено: 1');
    assert.match(await page.locator('#commandText').textContent(), /download.py/);
    await page.locator('#downloadSelected').click();
    await page.waitForFunction(() => document.querySelectorAll('.job.done').length === 2);
    assert.equal(await page.locator('.job-title').filter({ hasText: 'Sample _script_' }).count(), 1);
    await page.locator('#tools > summary').click();
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(artifacts, 'desktop-jobs.png'), fullPage: true });

    // Полная недоступность API и восстановление без перезагрузки страницы.
    await page.route('**/jobs', route => route.abort());
    await page.locator('#offline').waitFor();
    assert.equal(await page.locator('#downloadButton').isDisabled(), true);
    await page.unroute('**/jobs');
    await page.locator('#connection.online').waitFor();
    await page.locator('#clearJobs').click();
    await page.waitForFunction(() => document.querySelectorAll('.job').length === 0);
    assert.equal(fs.existsSync(saved), true);

    await page.getByRole('button', { name: 'Как это работает', exact: true }).click();
    await page.locator('#help[open]').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#help').isVisible(), false);
    await page.locator('#theme').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifacts, 'desktop-dark.png'), fullPage: true });
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#theme').click();
    await page.screenshot({ path: path.join(artifacts, 'mobile-light.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
    assert.deepEqual(errors, []);
    console.log('Browser smoke: PASS (form download, queue, cancel, retry, HTML, offline recovery, themes, mobile, keyboard, no page errors)');
    console.log('Screenshots:', artifacts);
  } finally {
    if (browser) await browser.close();
    lines.close();
    if (fixture.exitCode === null && fixture.signalCode === null) {
      fixture.kill('SIGTERM');
      await once(fixture, 'exit');
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
