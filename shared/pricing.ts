import { TIER_FEES, BOOST_FEES } from "./schema";

export function calculateTotal({
  basePay,
  tier,
  boost,
}: {
  basePay: number;
  tier: string;
  boost: string;
}): { basePay: number; tierFee: number; boostFee: number; totalAmount: number } {
  const tierFee = TIER_FEES[tier] || 0;
  const boostFee = BOOST_FEES[boost]?.fee || 0;
  const totalAmount = basePay + tierFee + boostFee;
  return { basePay, tierFee, boostFee, totalAmount };
}

export function getBoostExpiry(boost: string): Date | null {
  const hours = BOOST_FEES[boost]?.hours || 0;
  if (hours === 0) return null;
  const expiry = new Date();
  expiry.setHours(expiry.getHours() + hours);
  return expiry;
}

export function isBoostActive(boostExpiresAt: Date | null): boolean {
  if (!boostExpiresAt) return false;
  return new Date(boostExpiresAt) > new Date();
}
