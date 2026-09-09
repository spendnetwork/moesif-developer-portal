import test from "node:test";
import assert from "node:assert/strict";
import { BASIC_MINIMUM_GBP, validateBasicAmount } from "../src/lib/basic-purchase.js";

test("every Basic purchase starts at GBP 100", () => {
  assert.equal(BASIC_MINIMUM_GBP, 100);
  for (const amount of ["", "garbage", "99.99", "1", "0", "-5", "100.001", Infinity]) {
    assert.ok(validateBasicAmount(amount));
  }
  for (const amount of ["100", "100.00", "100.01", "250.50"]) {
    assert.equal(validateBasicAmount(amount), null);
  }
});
