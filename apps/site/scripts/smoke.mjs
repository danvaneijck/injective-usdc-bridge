/**
 * Browser smoke test for the site, in real Chrome. A stand-in wallet announces
 * itself over EIP-6963 and answers reads only (it refuses anything that would
 * sign), so this exercises connect, quoting against Circle, the chain picker,
 * the activity list, a tracking page and the status page, and fails on any
 * page error.
 *
 *   npm run dev &   # or point SITE_URL at a deployed site
 *   WALLET=0x... node scripts/smoke.mjs
 *
 * NO_GAS_ON=<chain name> checks the missing-gas warning on a chain where
 * WALLET holds none of the gas token (deposits start on Base).
 *
 * REFUND=<payer>:<sig>[,<sig>] also checks the Solana deposit refund: the
 * signatures are burns from Solana older than 5 days whose deposits are still
 * open, and the stand-in Solana wallet takes the payer's address. Reclaim is
 * pressed for real: the refund is built and simulated against mainnet, and
 * only the stand-in's refusal to sign stops it.
 *
 * Screenshots land in OUT (default ./smoke-out).
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const SITE = (process.env.SITE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const WALLET = process.env.WALLET;
/** A real Solana wallet with a USDC account (read-only use: balances and checks). */
const SOL_WALLET = process.env.SOL_WALLET ?? "CeeVcSmNej5z8zKaaoX4TUG1su7i3vPHut52vViNdeBi";
const TRACK = process.env.TRACK; // "<domain>/<txHash>" to open a tracking page
const REFUND = process.env.REFUND;
/** A chain where WALLET holds no gas token, e.g. "Base": the form must warn before signing. */
const NO_GAS_ON = process.env.NO_GAS_ON;
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

async function open(viewport, solAddress = SOL_WALLET) {
  const page = await browser.newPage({ viewport });
  // A Wallet Standard Solana wallet that connects and refuses to sign.
  await page.addInitScript((address) => {
    const account = Object.freeze({ address, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: ["solana:signTransaction"] });
    const wallet = {
      version: "1.0.0",
      name: "Smoke Solana",
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=",
      chains: ["solana:mainnet"],
      accounts: [],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async () => {
            throw new Error("smoke wallet does not sign");
          },
        },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e) => e.detail.register(wallet));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api) => api.register(wallet) }));
  }, solAddress);
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
  // The breakdown sits behind its summary line; open it once and it stays open.
  await page.getByRole("button", { name: /^About .*(No fees|Fees)/ }).click({ timeout: 20_000 });
  await page.getByText("You receive at least").waitFor({ timeout: 5000 });
});

await check("offers the gas drop on deposits", async () => {
  await page.getByText(/^Add [\d.]+ INJ for gas$/).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: `${OUT}/1-deposit.png` });
});

if (NO_GAS_ON) {
  await check(`warns that the wallet has no gas on ${NO_GAS_ON}`, async () => {
    await page.getByText(new RegExp(`This wallet has no \\w+ on ${NO_GAS_ON} to pay for gas`)).waitFor({ timeout: 20_000 });
  });
}

await check("picks a chain from the sheet, the popular ones first", async () => {
  await page.getByRole("button", { name: /^Base/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Bridge from" });
  await sheet.waitFor();
  const rows = await sheet.locator(".iub-chains button").allInnerTexts();
  if (!rows[0]?.startsWith("Solana") || !rows[1]?.startsWith("HyperEVM")) throw new Error(`list starts ${JSON.stringify(rows.slice(0, 3))}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/2-chains.png` });
  await sheet.getByRole("button", { name: /Arbitrum/ }).click();
  await sheet.waitFor({ state: "detached" });
  await page.getByText("You receive at least").waitFor({ timeout: 20_000 });
});

await check("searches chains and closes on Escape", async () => {
  await page.getByRole("button", { name: /^Arbitrum/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Bridge from" });
  await page.getByLabel("Search chains").fill("mon");
  const rows = await sheet.locator(".iub-chains button").allInnerTexts();
  if (rows.length !== 1 || !rows[0].startsWith("Monad")) throw new Error(`search "mon" showed ${JSON.stringify(rows)}`);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
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

// Solana, in a fresh page so the form starts from its defaults.
const sp = await open({ width: 1280, height: 900 });
await sp.goto(`${SITE}/`);

await check("connects a Solana wallet through Wallet Standard", async () => {
  await sp.getByRole("button", { name: "Connect wallet" }).first().click();
  await sp.getByRole("tab", { name: /Solana/ }).click();
  await sp.getByRole("button", { name: "Smoke Solana" }).click();
  await sp.getByRole("button", { name: new RegExp(`Solana wallet ${SOL_WALLET.slice(0, 4)}`) }).waitFor({ timeout: 5000 });
  await sp.keyboard.press("Escape");
});

await check("quotes a deposit from Solana", async () => {
  await sp.getByRole("button", { name: /^Base/ }).first().click();
  await sp.getByRole("dialog", { name: "Bridge from" }).getByRole("button", { name: /^Solana/ }).click();
  await sp.getByText(/^Balance/).waitFor({ timeout: 15_000 });
  await sp.getByLabel("Amount of USDC").fill("5");
  await sp.getByRole("button", { name: /^About .*(No fees|Fees)/ }).click({ timeout: 20_000 });
  await sp.getByText("Solana network fee").waitFor({ timeout: 5000 });
  await sp.getByText("You receive at least").waitFor();
  await sp.waitForTimeout(600);
  await sp.screenshot({ path: `${OUT}/9-solana-deposit.png` });
});

await check("quotes a withdrawal to Solana, delivered by Circle", async () => {
  await sp.getByRole("button", { name: "Swap direction" }).click();
  await sp.getByText(/^[\d.]+ USDC, by Circle$/).waitFor({ timeout: 20_000 });
  await sp.getByText(`To your wallet on Solana`).waitFor();
  await sp.waitForTimeout(600);
  await sp.screenshot({ path: `${OUT}/10-solana-withdraw.png` });
});

await check("refuses a token account typed as the Solana recipient", async () => {
  await sp.getByRole("button", { name: "Change" }).click();
  // The real burn spent from this account: SOL_WALLET's USDC token account.
  await sp.getByLabel("Recipient on Solana").fill("5NhytzwGCMAAYwgJZr1yJpaSYVqUQttWHGu3MpV4o38n");
  await sp.getByText(/That is a token account, not a wallet/).waitFor({ timeout: 15_000 });
  await sp.getByRole("button", { name: "Use my wallet" }).click();
});

if (REFUND) {
  const [payer, list] = REFUND.split(":");
  const sigs = list.split(",");
  await check("offers a Solana burn's deposit back, built and simulated up to the signature", async () => {
    const r = await open({ width: 1280, height: 900 }, payer);
    // Opening each burn's page has the service index it; wait until it shows.
    for (const sig of sigs.slice(1)) {
      await r.goto(`${SITE}/tx/5/${sig}`);
      await r.getByText(/^[\d,.]+ USDC$/).first().waitFor({ timeout: 60_000 });
    }
    await r.goto(`${SITE}/tx/5/${sigs[0]}`);
    await r.getByRole("button", { name: "Connect a Solana wallet to reclaim it" }).click({ timeout: 60_000 });
    await r.getByRole("button", { name: "Smoke Solana" }).click();
    const reclaim = r.getByRole("button", { name: /^Reclaim [\d.]+ SOL$/ });
    await reclaim.waitFor({ timeout: 10_000 });
    await r.waitForTimeout(400);
    await r.screenshot({ path: `${OUT}/11-refund.png` });
    await reclaim.click();
    await r.getByText("smoke wallet does not sign").waitFor({ timeout: 30_000 });
    await r.screenshot({ path: `${OUT}/12-refund-signing.png` });
  });

  await check("sums the deposits to reclaim in Activity", async () => {
    const a = await open({ width: 1280, height: 900 }, payer);
    await a.goto(`${SITE}/`);
    await a.getByRole("button", { name: "Connect wallet" }).first().click();
    await a.getByRole("tab", { name: /Solana/ }).click();
    await a.getByRole("button", { name: "Smoke Solana" }).click();
    await a.keyboard.press("Escape");
    await a.getByRole("tab", { name: /Activity/ }).click();
    const banner = a.locator(".iub-refund");
    await banner.getByText(/^[\d.]+ SOL to reclaim$/).waitFor({ timeout: 60_000 });
    // Each deposit joins once the service has tracked its burn; wait for all of them.
    if (sigs.length > 1) await banner.getByText(`Left by ${sigs.length} transfers from Solana`).waitFor({ timeout: 60_000 });
    await a.waitForTimeout(400);
    await a.screenshot({ path: `${OUT}/13-refund-activity.png` });
    await a.setViewportSize({ width: 390, height: 844 });
    await a.waitForTimeout(400);
    if (await a.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("the refund banner scrolls sideways at 390px");
    // Both wallet controls stay inside the header.
    const right = await a.locator(".site-wallet-bar").evaluate((el) => el.getBoundingClientRect().right);
    if (right > 390) throw new Error(`the wallet bar ends at ${Math.round(right)}px, past the 390px screen`);
    await a.screenshot({ path: `${OUT}/14-refund-phone.png` });
  });
}

await check("status page reads the health report", async () => {
  const s = await open({ width: 1280, height: 900 });
  await s.goto(`${SITE}/status`);
  await s.getByRole("heading", { name: "Chains" }).waitFor();
  await s.locator(".status-chain").first().waitFor({ timeout: 15_000 });
  const lanes = await s.locator(".status-chain").count();
  if (lanes < 10) throw new Error(`only ${lanes} chains listed`);
  const title = await s.locator(".status-hero h2").innerText();
  if (/Cannot reach|Checking/.test(title)) throw new Error(`status hero says "${title}"`);
  await s.screenshot({ path: `${OUT}/7-status.png`, fullPage: true });
});

await check("fits a phone", async () => {
  const m = await open({ width: 390, height: 844 });
  for (const path of ["/", "/status"]) {
    await m.goto(`${SITE}${path}`);
    if (path === "/") await m.getByLabel("Amount of USDC").fill("100");
    await m.waitForTimeout(3000);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error(`${path} scrolls sideways at 390px`);
    await m.screenshot({ path: `${OUT}/${path === "/" ? "6-phone" : "8-phone-status"}.png`, fullPage: true });
  }
});

await browser.close();
for (const e of errors) console.log(e);
if (failures.length || errors.length) {
  console.log(`${failures.length} failed, ${errors.length} page errors`);
  process.exit(1);
}
console.log("all good");
