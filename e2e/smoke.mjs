// End-to-end: real browser (iPhone 13 size) against the dev server. Run: node e2e/smoke.mjs [baseUrl]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://localhost:8787';
const shots = process.env.SHOTS || '/tmp/shots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], timezoneId: 'America/New_York' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const step = async (name, fn) => { process.stdout.write(`• ${name} … `); await fn(); console.log('ok'); };
const shot = (n) => page.screenshot({ path: `${shots}/${n}.png` });
const email = `ana${Date.now()}@example.com`;

await step('sign up', async () => {
  await page.goto(`${base}/#/signup`);
  await page.getByLabel('Your name').fill('Ana Duque');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByLabel('Family name').fill('Duque Family');
  await shot('01-signup');
  await page.getByRole('button', { name: 'Create our family space' }).click();
  await page.getByText('Good ', { exact: false }).first().waitFor();
  await shot('02-today-empty');
});

await step('create event with address autocomplete, reminder and people', async () => {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Event', exact: true }).click();
  await page.getByLabel('Title').fill('Soccer practice');
  const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
  const dates = page.locator('.sheet input[type=date]');
  await dates.nth(0).fill(today);
  await page.locator('.sheet input[type=time]').nth(0).fill('23:00');
  await page.locator('.sheet input[type=time]').nth(1).fill('23:45');
  await page.getByRole('button', { name: 'Kiddo 1' }).click();
  const loc = page.getByRole('combobox', { name: 'Location' });
  await loc.fill('Linc');
  await page.getByRole('option', { name: /Lincoln Elementary School/ }).waitFor();
  await shot('03-autocomplete');
  await loc.press('ArrowDown');
  await loc.press('Enter');
  await page.locator('.place-chip', { hasText: '50 School Rd, Essex' }).waitFor();
  await shot('04-event-editor');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Event saved').waitFor();
  await page.locator('.ev', { hasText: 'Soccer practice' }).first().waitFor();
  await shot('05-today-with-event');
});

await step('event persists after reload', async () => {
  await page.reload();
  await page.locator('.ev', { hasText: 'Soccer practice' }).first().waitFor();
});

await step('weekly recurring event shows in calendar month + agenda', async () => {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Event', exact: true }).click();
  await page.getByLabel('Title').fill('Piano lesson');
  await page.locator('.sheet select').first().selectOption('WEEKLY');
  await page.getByRole('button', { name: 'Kiddo 2' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Event saved').waitFor();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calendar' }).click();
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await shot('06-month');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  const n = await page.locator('.ev', { hasText: 'Piano lesson' }).count();
  assert.ok(n >= 8, `expected 8+ weekly piano occurrences in 60 days, got ${n}`);
  await shot('07-agenda');
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await shot('08-day');
});

await step('edit only one occurrence of the series', async () => {
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.locator('.ev', { hasText: 'Piano lesson' }).nth(1).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Title').fill('Piano recital');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Only this event' }).click();
  await page.getByText('Changes saved').waitFor();
  await page.locator('.ev', { hasText: 'Piano recital' }).first().waitFor();
  assert.equal(await page.locator('.ev', { hasText: 'Piano recital' }).count(), 1);
});

await step('task with quick add and tick off', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'More' }).click();
  await page.getByRole('link', { name: /Tasks & lists/ }).click();
  await page.getByLabel('New item').fill('Pack swim bag');
  await page.getByLabel('New item').press('Enter');
  await page.getByText('Pack swim bag').waitFor();
  await page.getByRole('checkbox', { name: /Pack swim bag/ }).click();
  await page.getByRole('checkbox', { name: /Mark “Pack swim bag” not done/ }).waitFor();
  await shot('09-tasks');
});

await step('assistant proposes, nothing saved until confirm', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assistant' }).click();
  await page.getByLabel('Message').fill('Dentist for Kiddo 2 in two days at 3:30');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('.proposal', { hasText: 'Dentist' }).waitFor();
  await shot('10-assistant-proposal');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calendar' }).click();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  assert.equal(await page.locator('.ev', { hasText: 'Dentist' }).count(), 0, 'not saved before confirm');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await page.locator('.proposal', { hasText: 'Dentist' }).getByRole('button', { name: 'Confirm' }).click();
  await page.locator('.toast', { hasText: 'Saved' }).first().waitFor();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Calendar' }).click();
  await page.locator('.ev', { hasText: 'Dentist' }).first().waitFor();
});

await step('family profile rename', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'More' }).click();
  await page.getByRole('link', { name: /Family profiles/ }).click();
  await page.getByRole('button', { name: /Kiddo 2/ }).click();
  await page.getByLabel('Name').fill('Mia');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /Mia/ }).waitFor();
  await shot('11-family');
});

await step('offline: app opens from cache and queues an edit, then syncs', async () => {
  await page.goto(`${base}/#/today`);
  await page.locator('.ev').first().waitFor();
  await page.waitForTimeout(800); // service worker install
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('Offline', { exact: false }).first().waitFor();
  await page.locator('.ev').first().waitFor();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'More' }).click();
  await page.getByRole('link', { name: /Tasks & lists/ }).click();
  await page.getByLabel('New item').fill('Buy sunscreen');
  await page.getByLabel('New item').press('Enter');
  await page.getByText('Waiting to sync').first().waitFor();
  await shot('12-offline');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !document.body.innerText.includes('Waiting to sync'), null, { timeout: 15000 });
  const r = await page.evaluate(async () => (await fetch('/api/sync', { headers: { 'x-ff': '1' } })).json());
  assert.ok(r.tasks.some((t) => t.title === 'Buy sunscreen'), 'offline task reached the server');
});

await step('diagnostics shows real statuses', async () => {
  await page.goto(`${base}/#/more/diagnostics`);
  await page.locator('.diag').first().waitFor({ timeout: 20000 });
  await shot('13-diagnostics');
  const txt = await page.locator('.card').first().innerText();
  assert.match(txt, /Database write\/read/);
});

await step('second adult joins by invite and sees shared events', async () => {
  await page.goto(`${base}/#/more/people`);
  await page.getByRole('button', { name: 'Invite an adult' }).click();
  const link = await page.locator('code.copy').innerText();
  const ctx2 = await browser.newContext({ ...devices['iPhone 13'], timezoneId: 'America/New_York' });
  const p2 = await ctx2.newPage();
  await p2.goto(link.replace(/^https?:\/\/[^/]+/, base));
  await p2.getByText('You’re invited').waitFor();
  await p2.getByLabel('Your name').fill('Leo');
  await p2.getByLabel('Email').fill(`leo${Date.now()}@example.com`);
  await p2.getByLabel('Password').fill('another good pass');
  await p2.getByRole('button', { name: /Join Duque Family/ }).click();
  await p2.waitForTimeout(2500); await p2.screenshot({ path: `${shots}/14-partner-debug.png` });
  await p2.locator('.ev', { hasText: 'Soccer practice' }).first().waitFor({ timeout: 5000 });
  await p2.screenshot({ path: `${shots}/14-partner-today.png` });
  await ctx2.close();
});

assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
await browser.close();
console.log('E2E passed');
