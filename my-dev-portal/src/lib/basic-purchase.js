export const BASIC_MINIMUM_GBP = 100;

export function validateBasicAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < BASIC_MINIMUM_GBP) {
    return "Enter an amount of at least GBP 100.00.";
  }
  if (!Number.isSafeInteger(Math.round(amount * 100)) || Math.round(amount * 100) > 2147483647 ||
      Math.abs(Math.round(amount * 100) / 100 - amount) > Number.EPSILON * 100) {
    return "Enter a valid amount with no more than two decimal places.";
  }
  return null;
}
