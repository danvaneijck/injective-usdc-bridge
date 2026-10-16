import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { IrisClient, IrisMessage } from "../src/iris.js";
import { resolveTransfer } from "../src/status.js";
import {
  INJ_TO_BASE_MESSAGE,
  INJ_TO_BASE_NONCE,
  INJ_TO_BASE_TX,
  completeMessage,
  pendingMessage,
} from "./fixtures.js";

function iris(messages: IrisMessage[]): IrisClient {
  return { getMessages: async () => messages } as unknown as IrisClient;
}

/** Replace the 32-byte expirationBlock (body bytes 196-228). */
function withExpiration(message: Hex, block: bigint): Hex {
  const start = 2 + (148 + 196) * 2;
  return (message.slice(0, start) +
    block.toString(16).padStart(64, "0") +
    message.slice(start + 64)) as Hex;
}

const base = { sourceDomain: 29, txHash: INJ_TO_BASE_TX };

describe("resolveTransfer", () => {
  it("not_found when Iris has nothing", async () => {
    const legs = await resolveTransfer({ ...base, iris: iris([]), isNonceUsed: vi.fn() });
    expect(legs).toEqual([{ phase: "not_found", sourceDomain: 29, txHash: INJ_TO_BASE_TX }]);
  });

  it("attesting while Iris waits for finality, without touching the chain", async () => {
    const isNonceUsed = vi.fn();
    const [leg] = await resolveTransfer({ ...base, iris: iris([pendingMessage()]), isNonceUsed });
    expect(leg?.phase).toBe("attesting");
    expect(isNonceUsed).not.toHaveBeenCalled();
  });

  it("Iris 'complete' alone is NOT delivered", async () => {
    const isNonceUsed = vi.fn().mockResolvedValue(false);
    const [leg] = await resolveTransfer({ ...base, iris: iris([completeMessage()]), isNonceUsed });
    expect(leg?.phase).toBe("ready");
    expect(leg?.permissionless).toBe(true);
    expect(leg?.forwardRequested).toBe(false);
    expect(leg?.burn?.amount).toBe(227_118_876n);
    expect(isNonceUsed).toHaveBeenCalledWith(6, INJ_TO_BASE_NONCE);
  });

  it("delivered only when the destination nonce is used", async () => {
    const [leg] = await resolveTransfer({
      ...base,
      iris: iris([completeMessage()]),
      isNonceUsed: async () => true,
    });
    expect(leg?.phase).toBe("delivered");
  });

  it("expired when the destination head passed expirationBlock", async () => {
    const msg = withExpiration(INJ_TO_BASE_MESSAGE, 1_000n);
    const [leg] = await resolveTransfer({
      ...base,
      iris: iris([completeMessage({ message: msg })]),
      isNonceUsed: async () => false,
      destinationBlock: async () => 1_000n,
    });
    expect(leg?.burn?.expirationBlock).toBe(1_000n);
    expect(leg?.phase).toBe("expired");
  });

  it("a delivered transfer is never reported expired", async () => {
    const msg = withExpiration(INJ_TO_BASE_MESSAGE, 1n);
    const [leg] = await resolveTransfer({
      ...base,
      iris: iris([completeMessage({ message: msg })]),
      isNonceUsed: async () => true,
      destinationBlock: async () => 10n,
    });
    expect(leg?.phase).toBe("delivered");
  });
});
