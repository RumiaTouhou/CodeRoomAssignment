import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

const baseURL = "http://127.0.0.1:18180";
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });
const rows = (page: Page) => conversation(page).locator("ol > li");
const textRow = (page: Page, content: string) => rows(page).filter({ has: page.getByText(content, { exact: true }) });
const codeRow = (page: Page, token: string) => rows(page).filter({ has: page.locator("pre code").filter({ hasText: token }) });
const connected = (page: Page) => page.getByRole("status", { name: "Connection: Connected", exact: true });
const audioStats = (page: Page) => page.evaluate(() => (window as unknown as { playbackStats: { attempts: number; successes: number } }).playbackStats);

async function submitJoin(page: Page, expectedStatus = 201): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [response] = await Promise.all([
      page.waitForResponse(value => new URL(value.url()).pathname === "/api/sessions" && value.request().method() === "POST"),
      page.getByRole("button", { name: "Join room", exact: true }).click(),
    ]);
    if (response.status() !== 429) {
      expect(response.status()).toBe(expectedStatus);
      if (expectedStatus === 201) await expect(connected(page)).toBeVisible();
      return;
    }
    const problem = await response.json() as { error?: { retryAfterMs?: number } };
    const delay = problem.error?.retryAfterMs ?? Number(response.headers()["retry-after"]) * 1000;
    expect(Number.isFinite(delay) && delay > 0 && delay <= 61_000).toBe(true);
    await expect(page.getByRole("button", { name: "Join room", exact: true })).toBeEnabled();
    await page.waitForTimeout(delay + 150);
  }
  throw new Error("The room continued to rate-limit joining after the advertised retry window");
}

async function join(page: Page, displayName: string, adminPassword?: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Display name", { exact: true }).fill(displayName);
  if (adminPassword !== undefined) await page.getByLabel(/^Admin password/).fill(adminPassword);
  await submitJoin(page);
}

async function participants(browser: Browser): Promise<{ alice: Page; bob: Page; contexts: BrowserContext[] }> {
  const contexts = await Promise.all([browser.newContext({ baseURL, permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 960, height: 800 } }), browser.newContext({ baseURL, permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 768, height: 760 } })]);
  const alice = await contexts[0]!.newPage(), bob = await contexts[1]!.newPage();
  await Promise.all([join(alice, "Alice"), join(bob, "Bob")]);
  return { alice, bob, contexts };
}

async function sendText(page: Page, content: string): Promise<Locator> {
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill(content);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const row = textRow(page, content);
  await expect(row.getByText("Sent to server", { exact: true })).toBeVisible();
  return row;
}

async function verticalOffset(row: Locator): Promise<number> {
  return row.evaluate(node => node.getBoundingClientRect().top - node.closest('[role="log"]')!.getBoundingClientRect().top);
}

test("Tab edits both composer buffers while keyboard focus remains escapable", async ({ browser }) => {
  const { alice, bob, contexts } = await participants(browser);
  const token = randomUUID().slice(0, 8);
  try {
    const text = alice.getByLabel("Message", { exact: true });
    await text.fill("**Here** I am");
    await expect(text).toHaveCSS("font-feature-settings", '"calt" 0');
    await expect(text).toHaveCSS("font-variant-ligatures", "no-contextual");
    await text.press("End");
    await text.press("Tab");
    await expect(text).toBeFocused();
    await expect(text).toHaveValue("**Here** I am\t");
    await text.pressSequentially(token);
    const body = `**Here** I am\t${token}`;
    await text.press("Escape");
    await text.press("Tab");
    await expect(alice.getByRole("button", { name: "Enter to send · Shift+Enter for a new line", exact: true })).toBeFocused();
    await text.focus();
    await text.press("Shift+Tab");
    await expect(alice.getByRole("button", { name: "Code", exact: true })).toBeFocused();
    await alice.getByRole("button", { name: "Send", exact: true }).click();
    await expect(textRow(bob, body)).toBeVisible();
    expect(await textRow(bob, body).locator("p").textContent()).toBe(body);
    await expect(textRow(bob, body).locator("p")).toHaveCSS("font-feature-settings", '"calt" 0');
    await expect(textRow(bob, body).locator("p")).toHaveCSS("font-variant-ligatures", "no-contextual");

    await alice.getByRole("button", { name: "Code", exact: true }).click();
    const code = alice.getByLabel("Code message", { exact: true });
    await code.fill(`snippet_${token}\nreturn 1;`);
    await code.press("Home");
    await code.press("Tab");
    const source = `snippet_${token}\n\treturn 1;`;
    await expect(code).toBeFocused();
    await expect(code).toHaveValue(source);
    await alice.reload();
    await expect(connected(alice)).toBeVisible();
    await expect(alice.getByLabel("Code message", { exact: true })).toHaveValue(source);
    await alice.getByLabel("Code message", { exact: true }).press("Control+Enter");
    await expect(codeRow(bob, `snippet_${token}`)).toBeVisible();
    expect(await codeRow(bob, `snippet_${token}`).locator("pre code").textContent()).toBe(source);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("two guests exchange raw code, typing, reactions, quotes and grouped messages", async ({ browser }) => {
  const { alice, bob, contexts } = await participants(browser);
  const token = randomUUID().slice(0, 8);
  try {
    const greeting = `Discussion ${token}`;
    await alice.getByLabel("Message", { exact: true }).fill(greeting);
    await expect(bob.getByText("Alice is typing…", { exact: true })).toBeVisible();
    await alice.getByLabel("Message", { exact: true }).press("Enter");
    await expect(textRow(bob, greeting)).toBeVisible();
    await expect(textRow(alice, greeting).getByText("Sent to server", { exact: true })).toBeVisible();
    await expect(bob.getByText("Alice is typing…", { exact: true })).not.toBeVisible();

    const identifier = `snippet_${token}`;
    const source = `export const ${identifier} = {\n\ttext: "**literal**",\n\thtml: "<div>plain text</div>"\n};\n`;
    await alice.getByRole("button", { name: "Code", exact: true }).click();
    await alice.getByRole("combobox").selectOption("typescript");
    await alice.getByLabel("Code message", { exact: true }).fill(source);
    await alice.getByLabel("Code message", { exact: true }).press("Control+Enter");
    const aliceCode = codeRow(alice, identifier), bobCode = codeRow(bob, identifier);
    await expect(bobCode).toBeVisible();
    expect(await bobCode.locator("pre code").textContent()).toBe(source);
    await bobCode.getByRole("button", { name: "Copy typescript code", exact: true }).click();
    await expect(bobCode.getByText("Copied", { exact: true })).toBeVisible();
    expect(await bob.evaluate(() => navigator.clipboard.readText())).toBe(source);

    await bobCode.getByRole("button", { name: "Add reaction", exact: true }).click();
    await bobCode.getByRole("menuitemcheckbox", { name: "React with check mark", exact: true }).click();
    const singleReaction = "React with check mark, 1 person", sharedReaction = "React with check mark, 2 people";
    await expect(bobCode.getByRole("button", { name: singleReaction, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(aliceCode.getByRole("button", { name: singleReaction, exact: true })).toHaveAttribute("aria-pressed", "false");
    await aliceCode.getByRole("button", { name: singleReaction, exact: true }).click();
    await expect(aliceCode.getByRole("button", { name: sharedReaction, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(bobCode.getByRole("button", { name: sharedReaction, exact: true })).toHaveAttribute("aria-pressed", "true");
    await bobCode.getByRole("button", { name: sharedReaction, exact: true }).click();
    await expect(aliceCode.getByRole("button", { name: singleReaction, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(bobCode.getByRole("button", { name: singleReaction, exact: true })).toHaveAttribute("aria-pressed", "false");

    await bobCode.hover();
    await bobCode.getByRole("button", { name: "Reply to Alice", exact: true }).click();
    await expect(bob.getByText("Replying to Alice", { exact: true })).toBeVisible();
    const reply = `Quoted reply ${token}`;
    await sendText(bob, reply);
    const quote = textRow(bob, reply).getByRole("button", { name: "Jump to message from Alice", exact: true });
    await expect(quote).toContainText(identifier);
    await quote.click();
    await expect(bobCode).toHaveClass(/cr-highlight-ring/);
    await expect(bob.getByRole("button", { name: "Back to reading position", exact: true })).toBeVisible();

    const first = `Consecutive message ${token} one`, second = `Consecutive message ${token} two`;
    await sendText(alice, first); await sendText(alice, second);
    await expect(textRow(bob, second)).toHaveCount(1);
    await expect(textRow(bob, first).locator("time")).toHaveCount(1);
    await expect(textRow(bob, second).locator("time")).toHaveCount(0);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("retained-history search and incoming messages preserve a reader's anchor", async ({ browser }) => {
  const { alice, bob, contexts } = await participants(browser);
  const token = randomUUID().slice(0, 8), needle = `needle_${token}`;
  try {
    for (let index = 0; index < 6; index++) {
      const body = [`History ${token} ${index}${index === 0 ? ` ${needle}` : ""}`, ...Array.from({ length: 7 }, (_, line) => `Context ${index}.${line} remains readable while the conversation continues.`)].join("\n");
      await sendText(alice, body);
      await expect(textRow(bob, body)).toHaveCount(1);
    }
    const viewport = conversation(bob);
    await viewport.hover();
    await bob.mouse.wheel(0, -100_000);
    await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(0);
    const anchorText = await viewport.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>("ol > li")].find(item => item.querySelector("p") && item.getBoundingClientRect().bottom > bounds.top && item.getBoundingClientRect().top < bounds.bottom);
      return row?.querySelector("p")?.textContent ?? null;
    });
    expect(anchorText).not.toBeNull();
    const anchor = textRow(bob, anchorText!).first(), offset = await verticalOffset(anchor);
    const arrivals = [`Live arrival ${token} one`, `Live arrival ${token} two`];
    for (const content of arrivals) await sendText(alice, content);
    await expect(bob.getByRole("button", { name: /^2 new messages.*Jump to latest$/ })).toBeVisible();
    await expect.poll(async () => Math.abs(await verticalOffset(anchor) - offset)).toBeLessThanOrEqual(2);

    const opener = bob.getByRole("button", { name: "Search recent messages", exact: true });
    await opener.click();
    const search = bob.getByRole("dialog", { name: "Search recent messages", exact: true });
    await expect(search.getByRole("searchbox", { name: "Search query", exact: true })).toBeFocused();
    await search.getByRole("searchbox", { name: "Search query", exact: true }).fill(needle);
    await expect(search.getByText("1 match", { exact: true })).toBeVisible();
    await search.getByRole("button", { name: "Jump to message from Alice", exact: true }).click();
    await expect(search).not.toBeVisible();
    await expect(rows(bob).filter({ hasText: needle })).toHaveClass(/cr-highlight-ring/);
    await bob.getByRole("button", { name: "Back to reading position", exact: true }).click();
    await expect.poll(async () => Math.abs(await verticalOffset(anchor) - offset)).toBeLessThanOrEqual(2);
    await bob.getByRole("button", { name: /^2 new messages.*Jump to latest$/ }).click();
    await expect(bob.getByRole("button", { name: /new messages.*Jump to latest/ })).not.toBeVisible();
    await expect.poll(() => viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(48);

    await opener.click();
    await search.getByRole("searchbox", { name: "Search query", exact: true }).fill(`absent_${token}`);
    await expect(search.getByText("No matches in retained history.", { exact: true })).toBeVisible();
    await search.getByRole("searchbox", { name: "Search query", exact: true }).press("Escape");
    await expect(search).not.toBeVisible(); await expect(opener).toBeFocused();
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("tab drafts, preferences and real reconnection survive a refresh and network interruption", async ({ browser }) => {
  const { alice, bob, contexts } = await participants(browser);
  const token = randomUUID().slice(0, 8);
  try {
    const text = `Unsent text ${token}`, source = `print("${token}")\n`;
    await alice.getByLabel("Message", { exact: true }).fill(text);
    await alice.getByRole("button", { name: "Code", exact: true }).click();
    await alice.getByRole("combobox").selectOption("python");
    await alice.getByLabel("Code message", { exact: true }).fill(source);
    await alice.getByLabel("Code message", { exact: true }).press("Enter");
    await expect(alice.getByLabel("Code message", { exact: true })).toHaveValue(source + "\n");
    await alice.reload(); await expect(connected(alice)).toBeVisible();
    await expect(alice.getByLabel("Code message", { exact: true })).toHaveValue(source + "\n");
    await expect(alice.getByRole("combobox")).toHaveValue("python");
    await alice.getByRole("button", { name: "Text", exact: true }).click();
    await expect(alice.getByLabel("Message", { exact: true })).toHaveValue(text);
    await expect(bob.getByLabel("Message", { exact: true })).toHaveValue("");

    await contexts[0]!.setOffline(true);
    await expect(alice.getByRole("status", { name: "Connection: Offline", exact: true })).toBeVisible();
    const offlineText = `Offline text ${token}`;
    await alice.getByLabel("Message", { exact: true }).fill(offlineText);
    await expect(alice.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    const duringInterruption = `Message during interruption ${token}`;
    await sendText(bob, duringInterruption);
    await contexts[0]!.setOffline(false); await expect(connected(alice)).toBeVisible({ timeout: 20_000 });
    await expect(textRow(alice, duringInterruption)).toHaveCount(1);
    await expect(alice.getByLabel("Message", { exact: true })).toHaveValue(offlineText);
    await expect(textRow(bob, offlineText)).toHaveCount(0);

    await alice.getByRole("button", { name: "Open preferences", exact: true }).click();
    const preferences = alice.getByRole("dialog", { name: "Preferences", exact: true });
    await preferences.getByRole("button", { name: "Ctrl/⌘+Enter to send", exact: true }).click();
    await expect(preferences.getByRole("button", { name: "Ctrl/⌘+Enter to send", exact: true })).toHaveAttribute("aria-pressed", "true");
    await preferences.getByRole("button", { name: "On", exact: true }).click();
    await expect(preferences.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(preferences.getByText(/Sound is ready\.|The browser blocked playback\.|Sound isn’t available in this browser\./)).toBeVisible();
    await preferences.getByRole("button", { name: "Off", exact: true }).click();
    await expect(preferences.getByRole("button", { name: "Preview", exact: true })).toBeDisabled();
    await preferences.getByRole("switch", { name: "Share when I’m typing", exact: true }).click();
    await expect(preferences.getByRole("switch", { name: "Share when I’m typing", exact: true })).toHaveAttribute("aria-checked", "false");
    await preferences.getByRole("button", { name: "Close preferences", exact: true }).click();
    await alice.getByLabel("Message", { exact: true }).press("Enter");
    await expect(alice.getByLabel("Message", { exact: true })).toHaveValue(offlineText + "\n");
    await expect(textRow(bob, offlineText)).toHaveCount(0);
    await alice.getByLabel("Message", { exact: true }).press("Control+Enter");
    await expect(textRow(bob, offlineText + "\n")).toHaveCount(1);
    await alice.reload(); await expect(connected(alice)).toBeVisible();
    await alice.getByRole("button", { name: "Open preferences", exact: true }).click();
    await expect(preferences.getByRole("button", { name: "Ctrl/⌘+Enter to send", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(preferences.getByRole("switch", { name: "Share when I’m typing", exact: true })).toHaveAttribute("aria-checked", "false");
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("saved incoming sound resumes after refresh without toggling the setting", async ({ browser }) => {
  const { alice, bob, contexts } = await participants(browser);
  const token = randomUUID().slice(0, 8);
  try {
    await bob.getByRole("button", { name: "Open preferences", exact: true }).click();
    const preferences = bob.getByRole("dialog", { name: "Preferences", exact: true });
    await preferences.getByRole("button", { name: "On", exact: true }).click();
    await expect(preferences.getByText("Sound is ready.", { exact: true })).toBeVisible();
    await bob.addInitScript(() => {
      const state = { attempts: 0, successes: 0 };
      Object.defineProperty(window, "playbackStats", { value: state });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        state.attempts++;
        return play.call(this).then(() => { state.successes++; });
      };
    });
    await bob.reload(); await expect(connected(bob)).toBeVisible();
    expect((await audioStats(bob)).attempts).toBe(0);
    await bob.getByLabel("Message", { exact: true }).click();
    await alice.bringToFront();
    await expect.poll(() => bob.evaluate(() => document.hasFocus())).toBe(false);
    await sendText(alice, `Incoming after refresh ${token}`);
    await expect.poll(async () => (await audioStats(bob)).successes).toBe(1);
    await bob.getByRole("button", { name: "Open preferences", exact: true }).click();
    await expect(preferences.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(preferences.getByText("Sound is ready.", { exact: true })).toBeVisible();
    await preferences.getByRole("button", { name: "Off", exact: true }).click();
    await bob.reload(); await expect(connected(bob)).toBeVisible();
    await alice.bringToFront();
    const muted = `Muted after refresh ${token}`;
    await sendText(alice, muted); await expect(textRow(bob, muted)).toBeVisible();
    expect((await audioStats(bob)).attempts).toBe(0);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("three guests see one administrator-managed pin and a restored identity remains a guest without its password", async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ baseURL, permissions: ["clipboard-read", "clipboard-write"] })));
  const [administrator, guest, rejected] = await Promise.all(contexts.map(context => context.newPage()));
  const token = randomUUID().slice(0, 8), adminName = `Admin ${token}`;
  try {
    await join(administrator!, adminName, "114514");
    await join(guest!, `Guest ${token}`);
    await rejected!.goto("/");
    await rejected!.getByLabel("Display name", { exact: true }).fill(`Visitor ${token}`);
    await rejected!.getByLabel(/^Admin password/).fill("wrong-room-password");
    await submitJoin(rejected!, 403);
    await expect(rejected!.getByRole("alert")).toContainText(/password/i);
    await rejected!.getByLabel(/^Admin password/).fill("");
    await submitJoin(rejected!);
    const source = `Public context ${token}\n` + "Complete pinned content remains literal.\n".repeat(14);
    const original = await sendText(administrator!, source);
    await original.hover();
    await original.getByRole("button", { name: `Pin message from ${adminName}`, exact: true }).click();
    for (const page of [administrator!, guest!, rejected!]) await expect(page.getByRole("region", { name: "Pinned message", exact: true })).toContainText(token);
    await expect(textRow(guest!, source).getByRole("button", { name: `Pin message from ${adminName}`, exact: true })).toHaveCount(0);
    await guest!.getByRole("button", { name: "View pinned message", exact: true }).click();
    const details = guest!.getByRole("dialog", { name: "Pinned message details", exact: true });
    expect(await details.locator("p.cr-message-text").textContent()).toBe(source);
    await details.getByRole("button", { name: "Close pinned message", exact: true }).click();
    await guest!.getByRole("button", { name: "Jump to pinned message", exact: true }).click();
    await expect(textRow(guest!, source).getByRole("button", { name: "Show less", exact: true })).toHaveAttribute("aria-expanded", "true");
    await administrator!.getByRole("button", { name: "Leave room", exact: true }).click();
    await expect(administrator!.getByRole("button", { name: "Join room", exact: true })).toBeVisible();
    await administrator!.getByLabel("Display name", { exact: true }).fill(adminName);
    await expect(administrator!.getByRole("checkbox", { name: "Use saved guest identity", exact: true })).toBeChecked();
    await administrator!.getByLabel(/^Admin password/).fill("");
    await submitJoin(administrator!);
    await expect(administrator!.getByRole("banner").getByText("Guest", { exact: true })).toBeVisible();
    await expect(administrator!.getByRole("button", { name: "Unpin message", exact: true })).toHaveCount(0);
    await expect(administrator!.getByRole("region", { name: "Pinned message", exact: true })).toContainText(token);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("folded code retains full copying and searching while bookmarks and reading preferences survive refresh", async ({ browser }) => {
  const { alice, bob, contexts } = await participants(browser);
  const token = randomUUID().slice(0, 8), needle = `folded_needle_${token}`;
  const source = Array.from({ length: 18 }, (_, index) => `\tconst line_${index} = "literal **text** <div>😀</div> ${index === 17 ? needle : token}";`).join("\n") + "\n";
  try {
    await alice.getByRole("button", { name: "Code", exact: true }).click();
    await alice.getByRole("combobox").selectOption("typescript");
    await alice.getByLabel("Code message", { exact: true }).fill(source);
    await alice.getByRole("button", { name: "Send", exact: true }).click();
    const row = codeRow(bob, needle);
    await expect(row.getByRole("button", { name: "Show more", exact: true })).toHaveAttribute("aria-expanded", "false");
    await row.getByRole("button", { name: "Copy typescript code", exact: true }).click();
    expect(await bob.evaluate(() => navigator.clipboard.readText())).toBe(source);
    await row.hover();
    await row.getByRole("button", { name: "Bookmark message from Alice", exact: true }).click();
    await bob.getByRole("button", { name: "Open bookmarks", exact: true }).click();
    const bookmarks = bob.getByRole("dialog", { name: "Saved bookmarks", exact: true });
    await bookmarks.getByRole("button", { name: "Show full bookmark", exact: true }).click();
    expect(await bookmarks.locator("pre code").textContent()).toBe(source);
    await bookmarks.getByRole("button", { name: "Copy bookmark from Alice", exact: true }).click();
    expect(await bob.evaluate(() => navigator.clipboard.readText())).toBe(source);
    await bookmarks.getByRole("button", { name: "Close bookmarks", exact: true }).click();
    await bob.getByRole("button", { name: "Open preferences", exact: true }).click();
    const preferences = bob.getByRole("dialog", { name: "Preferences", exact: true });
    await preferences.getByRole("group", { name: "Reading size", exact: true }).getByRole("button", { name: "Larger", exact: true }).click();
    await preferences.getByRole("switch", { name: "Member activity sounds", exact: true }).click();
    await preferences.getByRole("button", { name: "Close preferences", exact: true }).click();
    await expect(row.locator("pre")).toHaveCSS("font-size", "18px");
    await expect(bob.getByLabel("Message", { exact: true })).toHaveCSS("font-size", "20px");
    await expect(codeRow(alice, needle).locator("pre")).toHaveCSS("font-size", "14px");
    await bob.getByRole("button", { name: "Search recent messages", exact: true }).click();
    const search = bob.getByRole("dialog", { name: "Search recent messages", exact: true });
    await search.getByRole("searchbox", { name: "Search query", exact: true }).fill(needle);
    await expect(search.getByText("1 match", { exact: true })).toBeVisible();
    await search.getByRole("button", { name: "Jump to message from Alice", exact: true }).click();
    await expect(row.getByRole("button", { name: "Show less", exact: true })).toHaveAttribute("aria-expanded", "true");
    expect(await row.locator("pre code").textContent()).toBe(source);
    await bob.reload(); await expect(connected(bob)).toBeVisible();
    await expect(bob.getByLabel("Message", { exact: true })).toHaveCSS("font-size", "20px");
    await bob.getByRole("button", { name: "Open preferences", exact: true }).click();
    await expect(preferences.getByRole("switch", { name: "Member activity sounds", exact: true })).toHaveAttribute("aria-checked", "false");
    await preferences.getByRole("button", { name: "Close preferences", exact: true }).click();
    await bob.getByRole("button", { name: "Open bookmarks", exact: true }).click();
    await expect(bookmarks.getByRole("button", { name: "View source from Alice", exact: true })).toBeEnabled();
    await bookmarks.getByRole("button", { name: "Clear all", exact: true }).click();
    await bookmarks.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(bookmarks.getByRole("button", { name: "Copy bookmark from Alice", exact: true })).toBeVisible();
    await bookmarks.getByRole("button", { name: "Clear all", exact: true }).click();
    await bookmarks.getByRole("button", { name: "Clear bookmarks", exact: true }).click();
    await expect(bookmarks.getByText("No saved bookmarks", { exact: true })).toBeVisible();
    await alice.getByRole("button", { name: "Open bookmarks", exact: true }).click();
    await expect(alice.getByRole("dialog", { name: "Saved bookmarks", exact: true }).getByText("No saved bookmarks", { exact: true })).toBeVisible();
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("member notices suppress refresh noise and distinguish explicit leave from return", async ({ browser }) => {
  const { alice, bob, contexts } = await participants(browser);
  const visitorContext = await browser.newContext({ baseURL }); contexts.push(visitorContext);
  const visitor = await visitorContext.newPage(), name = `Visitor ${randomUUID().slice(0, 8)}`;
  try {
    await join(visitor, name);
    const activity = alice.getByRole("status", { name: "Member activity", exact: true });
    await expect(activity.getByText(`${name} joined`, { exact: true })).toBeVisible();
    await expect(alice.getByRole("log").getByText(`${name} joined the room.`, { exact: true })).toBeVisible();
    await visitor.reload(); await expect(connected(visitor)).toBeVisible();
    await expect(activity.getByText(`${name} joined`, { exact: true })).toHaveCount(1);
    await expect(activity.getByText(`${name} left`, { exact: true })).toHaveCount(0);
    await expect(activity.getByText(`${name} returned`, { exact: true })).toHaveCount(0);
    await visitor.getByRole("button", { name: "Leave room", exact: true }).click();
    await expect(bob.getByRole("status", { name: "Member activity", exact: true }).getByText(`${name} left`, { exact: true })).toBeVisible({ timeout: 2000 });
    await expect(bob.getByRole("log").getByText(`${name} left the room.`, { exact: true })).toBeVisible({ timeout: 2000 });
    await visitor.getByLabel("Display name", { exact: true }).fill(name);
    await submitJoin(visitor);
    await expect(activity.getByText(`${name} returned`, { exact: true })).toBeVisible();
    await expect(alice.getByRole("log").getByText(`${name} returned to the room.`, { exact: true })).toBeVisible();
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
