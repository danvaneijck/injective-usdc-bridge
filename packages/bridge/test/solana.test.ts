import { describe, expect, it } from "vitest";
import { usedNonceAddress } from "../src/solana.js";

describe("Solana used_nonce PDA", () => {
  it("matches the account of a delivered mainnet transfer", () => {
    // Injective -> Solana, 9,999 USDC, delivered. The account was confirmed to
    // exist on mainnet on 2026-10-16 (and a random nonce's did not).
    expect(
      usedNonceAddress("0xe21e462d0a8aa6963f21580592adf83824b266325350b393240a6bb7737a02cb"),
    ).toBe("C2PPx3TzeyWVXGMiEpt412zNPv9X5cj48KrWB2x6pztE");
  });
});
