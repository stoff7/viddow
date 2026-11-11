// Общие инструменты только для проверок; приложение не зависит от Playwright.
const assert = require('node:assert/strict');
const path = require('node:path');
const extensionPath = path.resolve(__dirname, '../extension');

async function openPanel(context, worker, source) {
  await source.bringToFront();
  const windowId = await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({ active: true });
    return tabs.find(tab => tab.url === url).windowId;
  }, source.url());
  // sidePanel.open требует user gesture. Launcher нужен только для открытия,
  // все проверяемые действия далее происходят в настоящем SIDE_PANEL.
  const [launcher] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url }), {
      windowId, url: new URL('popup.html', worker.url()).href,
    }),
  ]);
  await launcher.waitForLoadState();
  await launcher.evaluate(windowId => {
    const button = document.createElement('button');
    button.id = 'openTestPanel'; button.textContent = 'Открыть тестовую панель';
    button.onclick = () => chrome.sidePanel.open({ windowId });
    document.body.prepend(button);
  }, windowId);
  const [panel] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000, predicate: page => page.url() === launcher.url() }),
    launcher.locator('#openTestPanel').click(),
  ]);
  await panel.waitForLoadState();
  await launcher.close();
  await source.bringToFront();
  assert.equal(await panel.evaluate(async () => (await chrome.tabs.getCurrent())?.id ?? null), null);
  const contexts = await panel.evaluate(() => chrome.runtime.getContexts({}));
  assert.equal(contexts.some(context => context.contextType === 'SIDE_PANEL'), true, JSON.stringify(contexts));
  assert.equal(await panel.evaluate(async () => (await chrome.windows.getCurrent()).id), windowId);
  return panel;
}

module.exports = { extensionPath, openPanel };
