export const TARIFFS = Object.freeze({
  standard: {
    pix: { bps: 0, fixedCents: 100 },     // 0% + R$ 1,00
    card: { bps: 399, fixedCents: 39 }    // 3,99% + R$ 0,39
  },
  pro: {
    pix: { bps: 0, fixedCents: 50 },      // 0% + R$ 0,50
    card: { bps: 299, fixedCents: 30 }    // 2,99% + R$ 0,30
  }
});

/**
 * Calculates the exact fee in cents strictly on the server.
 * Any client-supplied fee is disregarded.
 */
export function calculateServerFee(amountCents, method, plan = 'standard') {
  if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 100000000) {
    throw new Error('invalid_amount: Amount must be between 100 cents (R$ 1.00) and 100,000,000 cents');
  }
  if (!['pix', 'card'].includes(method)) {
    throw new Error('invalid_method: Method must be pix or card');
  }
  const tariffPlan = TARIFFS[plan];
  if (!tariffPlan) {
    throw new Error(`invalid_plan: Unknown merchant plan '${plan}'`);
  }
  const rule = tariffPlan[method];
  if (!rule) {
    throw new Error(`invalid_tariff_rule: No rule for method '${method}' on plan '${plan}'`);
  }

  // Exact ceil calculation without floating point precision issues
  const proportional = (BigInt(amountCents) * BigInt(rule.bps) + 9999n) / 10000n;
  const totalFee = Number(proportional) + rule.fixedCents;

  return Math.min(amountCents, totalFee);
}
