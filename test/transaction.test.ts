import { afterAll, describe, expect, it } from "vitest";
import { pool, withTransaction } from "../src/db.js";
import { DomainError } from "../src/errors.js";

afterAll(async () => {
  await pool.end();
});

function mysqlError(errno: number): Error {
  return Object.assign(new Error(`mysql error ${errno}`), { errno });
}

describe("withTransaction", () => {
  it("retries a transaction that MySQL aborted with a deadlock", async () => {
    let attempts = 0;
    const result = await withTransaction(async () => {
      attempts += 1;
      if (attempts === 1) throw mysqlError(1213);
      return "done";
    });

    expect(result).toBe("done");
    expect(attempts).toBe(2);
  });

  it("gives up after 3 attempts", async () => {
    let attempts = 0;
    const failing = withTransaction(async () => {
      attempts += 1;
      throw mysqlError(1205);
    });

    await expect(failing).rejects.toMatchObject({ errno: 1205 });
    expect(attempts).toBe(3);
  });

  it("never retries a domain decline", async () => {
    let attempts = 0;
    const declined = withTransaction(async () => {
      attempts += 1;
      throw new DomainError("seat_taken");
    });

    await expect(declined).rejects.toBeInstanceOf(DomainError);
    expect(attempts).toBe(1);
  });
});
