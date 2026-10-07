import { getRevenueCatProductIds } from '../config/revenuecat-product-ids';
import {
  calculateAnnualSavingsPercent,
  formatFallbackPrice,
  VOXA_PRICING,
} from './voxa-pricing';
import { BillingPeriod, PlanLimits, UNLIMITED } from '../types/subscription';

/** Central pricing & plan configuration — store metadata overrides display values. */
export const PRICING_CONFIG = {
  currency: VOXA_PRICING.currency,
  currencySymbol: VOXA_PRICING.currencySymbol,
  trialDays: VOXA_PRICING.trialDaysDisplayFallback,
  entitlementId: VOXA_PRICING.entitlementId,
  offeringId: VOXA_PRICING.offeringId,
  plans: {
    free: {
      id: 'free' as const,
      label: 'Free',
      description: 'Everything you need to start with Voxa.',
    },
    pro: {
      id: 'pro' as const,
      label: 'Voxa Pro',
      description: 'Deeper companion intelligence, Life OS, and generous fair use.',
    },
  },
  prices: {
    monthly: VOXA_PRICING.monthlyFallbackGBP,
    annual: VOXA_PRICING.annualFallbackGBP,
  },
  /** Prefer `getRevenueCatProductIds()` — this getter keeps call sites compatible. */
  get productIds() {
    return getRevenueCatProductIds();
  },
  billingPeriods: {
    monthly: {
      id: 'monthly' as BillingPeriod,
      label: 'Monthly',
      price: VOXA_PRICING.monthlyFallbackGBP,
      periodLabel: '/month',
    },
    annual: {
      id: 'annual' as BillingPeriod,
      label: 'Annual',
      price: VOXA_PRICING.annualFallbackGBP,
      periodLabel: '/year',
      savingsLabel: `Save ${calculateAnnualSavingsPercent(
        VOXA_PRICING.monthlyFallbackGBP,
        VOXA_PRICING.annualFallbackGBP,
      )}%`,
    },
  },
} as const;

/** Fair-use caps for Pro — not advertised as unlimited. */
const PRO_FAIR_USE = 500;

export const FREE_PLAN_LIMITS: PlanLimits = {
  aiMessagesDaily: 150,
  aiMessagesMonthly: 3000,
  voiceMinutesDaily: 5,
  voiceMinutesMonthly: 30,
  imageUploadsDaily: 2,
  imageUploadsMonthly: 30,
  voiceNotesDaily: 5,
  voiceNotesMonthly: 50,
  videoUploadsDaily: 1,
  videoUploadsMonthly: 10,
  documentsDaily: 2,
  documentsMonthly: 20,
  storageBytesMonthly: 100 * 1024 * 1024,
  memoriesMax: 50,
  goalsMax: 5,
  remindersMax: 10,
  routinesMax: 8,
  historyDays: 30,
};

export const PRO_PLAN_LIMITS: PlanLimits = {
  aiMessagesDaily: PRO_FAIR_USE,
  aiMessagesMonthly: PRO_FAIR_USE * 10,
  voiceMinutesDaily: PRO_FAIR_USE,
  voiceMinutesMonthly: PRO_FAIR_USE * 10,
  imageUploadsDaily: 50,
  imageUploadsMonthly: PRO_FAIR_USE,
  voiceNotesDaily: PRO_FAIR_USE,
  voiceNotesMonthly: PRO_FAIR_USE * 10,
  videoUploadsDaily: 50,
  videoUploadsMonthly: PRO_FAIR_USE,
  documentsDaily: 50,
  documentsMonthly: PRO_FAIR_USE,
  storageBytesMonthly: 5 * 1024 * 1024 * 1024,
  memoriesMax: UNLIMITED,
  goalsMax: UNLIMITED,
  remindersMax: UNLIMITED,
  routinesMax: UNLIMITED,
  historyDays: UNLIMITED,
};

export const PRO_VALUE_GROUPS = [
  {
    title: 'Deeper companion',
    items: [
      'Advanced memory retrieval',
      'Pinned permanent memories',
      'Memory connections',
      'Richer relationship timeline',
      'Weekly Companion Letter',
      'Deeper personalisation',
    ],
  },
  {
    title: 'Build your life',
    items: [
      'Full Goal Planner',
      'Future Self',
      'Vision Board',
      'Bucket List',
      'Life Book',
      'Decision Simulator',
      'Specialist coaching',
    ],
  },
  {
    title: 'Understand yourself',
    items: [
      'Mood trends',
      'Advanced insights',
      'Weekly & monthly reviews',
      'Coach score',
      'Dream themes',
      'Progress comparisons',
    ],
  },
  {
    title: 'Enjoy Voxa',
    items: [
      'Premium worlds',
      'Premium cosmetics',
      'Extra arcade & challenge experiences',
      'Custom themes',
      'Additional companion expressions',
    ],
  },
] as const;

export const PRO_TOP_BENEFITS = [
  'Higher fair-use AI conversations',
  'Advanced memory depth and pinned memories',
  'Full Life Book and Life OS tools',
  'Companion insights and Weekly Letter',
  'Premium voices and richer personalisation',
  'Advanced Note AI actions',
] as const;

export const FREE_VS_PRO_COMPARISON = [
  { label: 'AI chat', free: '20/day', pro: 'Generous fair use' },
  { label: 'Memories', free: '50 active', pro: 'Advanced & pinned' },
  { label: 'Life Book', free: 'Preview', pro: 'Full chapters' },
  { label: 'Life OS tools', free: 'Preview', pro: 'Full access' },
  { label: 'Weekly Letter', free: 'Preview', pro: 'Full letter' },
  { label: 'Note AI', free: 'Basic', pro: 'Advanced actions' },
  { label: 'Mood insights', free: 'Basic', pro: 'Advanced trends' },
  { label: 'Companion voices', free: 'Standard', pro: 'Premium voices' },
] as const;

export const FREE_FEATURES = [
  'Meaningful AI chat with a daily allowance',
  'Daily check-in, routines and goals',
  'Basic Journey, Notes and memories',
  'Challenge Me with fair limits',
  'Spoken reply playback',
  'Privacy, export and account controls',
] as const;

export { calculateAnnualSavingsPercent } from './voxa-pricing';

export function formatPrice(amount: number): string {
  return formatFallbackPrice(amount, PRICING_CONFIG.currencySymbol);
}

export function formatPriceFromStore(priceString?: string, fallbackAmount?: number): string {
  if (priceString) return priceString;
  if (fallbackAmount != null) return formatPrice(fallbackAmount);
  return formatPrice(PRICING_CONFIG.prices.monthly);
}
