import { CREDIT_COSTS } from "./schema";

export const INITIAL_CREDITS = 3;

export function getPostCreditCost(tier: string): number {
  return CREDIT_COSTS.post[tier] || 1;
}

export function getEventCreditCost(isNsfw: boolean): number {
  return isNsfw ? CREDIT_COSTS.eventNsfw : CREDIT_COSTS.event;
}

export function getBoostCreditCost(boost: string): number {
  return CREDIT_COSTS.boost[boost] || 0;
}

export function getApplyCreditCost(): number {
  return CREDIT_COSTS.apply;
}

export function getVerificationCreditCost(): number {
  return CREDIT_COSTS.verification;
}

export function canAfford(balance: number, cost: number, plan: string): boolean {
  if (plan === "elite") return true;
  return balance >= cost;
}
