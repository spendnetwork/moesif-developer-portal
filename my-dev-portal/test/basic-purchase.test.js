import test from "node:test";
import assert from "node:assert/strict";
import { BASIC_MINIMUM_GBP, validateBasicAmount } from "../src/lib/basic-purchase.js";

test("every Basic purchase starts at GBP 50", () => {
  assert.equal(BASIC_MINIMUM_GBP, 50);
  for (const amount of ["", "garbage", "49.99", "1", "0", "-5", "50.001", Infinity]) {
    assert.ok(validateBasicAmount(amount));
  }
  for (const amount of ["50", "50.00", "50.01", "250.50"]) {
    assert.equal(validateBasicAmount(amount), null);
  }
});
