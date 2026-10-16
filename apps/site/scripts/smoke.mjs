/**
 * Browser smoke test for the site, in real Chrome. A stand-in wallet announces
 * itself over EIP-6963 and answers reads only (it refuses anything that would
 * sign), so this exercises connect, quoting against Circle, the chain list,
 * the activity list and a tracking page, and fails on any page error.
 *
 *   npm run dev &   # or point SITE_URL at a deployed site
 *   WALLET=0x... node scripts/smoke.mjs
 *
 * Screenshots land in OUT (default ./smoke-out).
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const SITE = (process.env.SITE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const WALLET = process.env.WALLET;
const TRACK = process.env.TRACK; // "<domain>/<txHash>" to open a tracking page
const OUT = process.env.OUT ?? "./smoke-out";
if (!WALLET) throw new Error("WALLET=0x... is required");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true });
const errors = [];
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${String(e.message).split("\n")[0]}`);
  }
}

async function open(viewport) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript((address) => {
    const provider = {
      async request({ method }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
        if (method === "eth_chainId") return "0x6f0";
        throw Object.assign(new Error(`smoke wallet does not ${method}`), { code: 4200 });
      },
      on() {},
      removeListener() {},
    };
    const detail = Object.freeze({ info: { uuid: "smoke", name: "Smoke Wallet", icon: "", rdns: "test.smoke" }, provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, WALLET);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return page;
}

const page = await open({ width: 1280, height: 900 });
await page.goto(`${SITE}/`);

await check("connects through EIP-6963", async () => {
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.getByRole("button", { name: "Smoke Wallet" }).click();
  await page.getByText(`${WALLET.slice(0, 6)}...`).first().waitFor({ timeout: 5000 });
});

await check("quotes a Base deposit", async () => {
  await page.getByLabel("Amount of USDC").fill("25");
  await page.getByText("You receive at least").waitFor({ timeout: 20_000 });
});

await check("offers the gas drop on deposits", async () => {
  await page.getByText(/^Add [\d.]+ INJ for gas$/).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: `${OUT}/1-deposit.png` });
});

await check("lists chains", async () => {
  await page.getByRole("button", { name: /Base/ }).first().click();
  await page.getByText("Bridge from").waitFor();
  await page.screenshot({ path: `${OUT}/2-chains.png` });
  await page.getByRole("button", { name: /Arbitrum/ }).click();
  await page.getByText("You receive at least").waitFor({ timeout: 20_000 });
});

await check("quotes a withdrawal with Circle delivery, never showing the old quote", async () => {
  await page.getByRole("button", { name: "Swap direction" }).click();
  // Straight after the flip, the deposit's quote must be gone, not relabelled.
  if (await page.getByText("You claim it").count()) throw new Error("stale deposit quote shown for the withdrawal");
  await page.getByText(/^[\d.]+ USDC, by Circle$/).waitFor({ timeout: 20_000 });
  const circleFee = await page.locator(".iub-fees div", { hasText: "Circle fee" }).locator("dd").innerText();
  if (circleFee !== "Free") throw new Error(`Injective has no Fast transfer, but the Circle fee reads "${circleFee}"`);
  await page.screenshot({ path: `${OUT}/3-withdraw.png` });
});

await check("shows activity", async () => {
  await page.getByRole("tab", { name: /Activity/ }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/4-activity.png` });
});

if (TRACK) {
  await check("tracking page", async () => {
    const t = await open({ width: 1280, height: 900 });
    await t.goto(`${SITE}/tx/${TRACK}`);
    await t.getByText("Circle approval").waitFor({ timeout: 15_000 });
    await t.waitForTimeout(2000);
    await t.screenshot({ path: `${OUT}/5-track.png` });
  });
}

await check("fits a phone", async () => {
  const m = await open({ width: 390, height: 844 });
  await m.goto(`${SITE}/`);
  await m.getByLabel("Amount of USDC").fill("100");
  await m.waitForTimeout(3000);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error("page scrolls sideways at 390px");
  await m.screenshot({ path: `${OUT}/6-phone.png`, fullPage: true });
});

await browser.close();
for (const e of errors) console.log(e);
if (failures.length || errors.length) {
  console.log(`${failures.length} failed, ${errors.length} page errors`);
  process.exit(1);
}
console.log("all good");
