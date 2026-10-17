export const TARIFFS: Record<string, Record<string, { bps: number; fixedCents: number }>> = {
  standard: {
    pix: { bps: 0, fixedCents: 100 },     // 0% + R$ 1,00
    card: { bps: 399, fixedCents: 39 },   // 3,99% + R$ 0,39
  },
  pro: {
    pix: { bps: 0, fixedCents: 50 },      // 0% + R$ 0,50
    card: { bps: 299, fixedCents: 30 },   // 2,99% + R$ 0,30
  },
};

export function calculateServerFee(amountCents: number, method: string, plan = "standard"): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 100000000) {
    throw new Error("invalid_amount");
  }
  if (!["pix", "card"].includes(method)) {
    throw new Error("invalid_method");
  }
  const tariffPlan = TARIFFS[plan] || TARIFFS.standard;
  const rule = tariffPlan[method];
  if (!rule) {
    throw new Error("invalid_tariff_rule");
  }
  const proportional = (BigInt(amountCents) * BigInt(rule.bps) + 9999n) / 10000n;
  const totalFee = Number(proportional) + rule.fixedCents;
  return Math.min(amountCents, totalFee);
}
