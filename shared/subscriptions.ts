export const PLAN_DETAILS = {
  free: {
    name: "Free",
    monthlyCredits: 3,
    boostsEnabled: false,
    verificationIncluded: false,
    unlimitedPosts: false,
    unlimitedBoosts: false,
    autoVerified: false,
    prioritySorting: false,
  },
  pro: {
    name: "Pro",
    monthlyCredits: 30,
    boostsEnabled: true,
    verificationIncluded: true,
    unlimitedPosts: false,
    unlimitedBoosts: false,
    autoVerified: false,
    prioritySorting: false,
  },
  elite: {
    name: "Elite",
    monthlyCredits: 999,
    boostsEnabled: true,
    verificationIncluded: true,
    unlimitedPosts: true,
    unlimitedBoosts: true,
    autoVerified: true,
    prioritySorting: true,
  },
} as const;

export type PlanType = keyof typeof PLAN_DETAILS;

export function getPlanDetails(plan: string) {
  return PLAN_DETAILS[plan as PlanType] || PLAN_DETAILS.free;
}

export function canUseBoosts(plan: string): boolean {
  return getPlanDetails(plan).boostsEnabled;
}

export function hasUnlimitedPosts(plan: string): boolean {
  return getPlanDetails(plan).unlimitedPosts;
}
