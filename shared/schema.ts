import { pgTable, text, serial, integer, boolean, timestamp, jsonb, varchar } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
export * from "./models/auth";

export const TIERS = ["Slots", "Missions", "Tasks", "Projects", "Chances"] as const;
export const CATEGORIES = [
  "Music", "Dance", "Comedy", "Modeling", "Acting",
  "Hair & Beauty", "Barber", "Nails", "Errands & Tasks",
  "Companionship", "Tutoring", "Photography", "Videography", "DJ/Audio",
  "Bartending", "Catering", "Waitstaff & Servers",
  "Event Setup & Takedown", "Promoters & Marketing",
  "Tailoring & Alterations", "Custom Sneakers & Shoes",
  "Fitness & Training", "Chefs & Culinary",
  "Entertainment Managers", "Consultants",
  "Warehouse & Logistics", "Cleaning & Janitorial",
  "Sales & Retail", "Studio & Engineering",
  "General Labor", "Skilled Trades",
  "Other"
] as const;

export const NSFW_CATEGORY = "Adult/NSFW" as const;
export const ALL_CATEGORIES = [...CATEGORIES, NSFW_CATEGORY] as const;

export const CATEGORY_GROUPS: Record<string, string[]> = {
  "Music & Entertainment": [
    "Music", "Dance", "Comedy", "Acting", "DJ/Audio",
    "Studio & Engineering", "Entertainment Managers",
  ],
  "Beauty & Style": [
    "Hair & Beauty", "Barber", "Nails", "Modeling",
    "Tailoring & Alterations", "Custom Sneakers & Shoes",
  ],
  "Food & Hospitality": [
    "Bartending", "Catering", "Waitstaff & Servers", "Chefs & Culinary",
  ],
  "Events & Production": [
    "Promoters & Marketing", "Photography", "Videography",
    "Event Setup & Takedown",
  ],
  "Labor & Trades": [
    "Warehouse & Logistics", "General Labor", "Skilled Trades",
    "Cleaning & Janitorial",
  ],
  "Professional Services": [
    "Tutoring", "Consultants", "Fitness & Training", "Sales & Retail",
  ],
  "Personal Services": [
    "Errands & Tasks", "Companionship",
  ],
};

export function getRelatedCategories(category: string): string[] {
  for (const group of Object.values(CATEGORY_GROUPS)) {
    if (group.includes(category)) {
      return group;
    }
  }
  return [category];
}

export function getCategoryGroupName(category: string): string | null {
  for (const [groupName, group] of Object.entries(CATEGORY_GROUPS)) {
    if (group.includes(category)) {
      return groupName;
    }
  }
  return null;
}

export const POST_TYPES = ["gig", "event"] as const;

export const EVENT_CATEGORIES = [
  "Club Party", "Festival", "Concert", "Job Fair",
  "Open Mic", "Art Show", "Pop-Up Shop", "Community Meetup",
  "Sports Event", "Block Party", "Networking Event", "Showcase",
  "Other Event"
] as const;

export const ALL_EVENT_CATEGORIES = [...EVENT_CATEGORIES, "Adult Club Event"] as const;

export const APPLICATION_STATUSES = ["pending", "accepted", "rejected"] as const;
export const PLANS = ["free", "pro", "elite"] as const;
export const BOOKING_STATUSES = ["pending_payment", "payment_submitted", "confirmed", "cancelled"] as const;

export const BOOSTS = ["None", "24h Boost", "72h Boost", "7 Day Featured"] as const;

export const PLATFORM_FEE_PERCENT = 6;

export const TIER_FEES: Record<string, number> = {
  "Slots": 0.25,
  "Missions": 0.5,
  "Tasks": 1,
  "Projects": 2,
  "Chances": 2.5
};

export const BOOST_FEES: Record<string, { fee: number; hours: number }> = {
  "None": { fee: 0, hours: 0 },
  "24h Boost": { fee: 3, hours: 24 },
  "72h Boost": { fee: 7, hours: 72 },
  "7 Day Featured": { fee: 15, hours: 168 },
};

export const CREDIT_COSTS = {
  post: { Slots: 1, Missions: 2, Tasks: 3, Projects: 4, Chances: 5 } as Record<string, number>,
  event: 1,
  eventNsfw: 3,
  boost: { "None": 0, "24h Boost": 2, "72h Boost": 4, "7 Day Featured": 8 } as Record<string, number>,
  apply: 1,
  verification: 10,
};

export const ADMIN_EMAILS = ["cubansreupspots@gmail.com"];

export const LICENSED_CATEGORIES: Record<string, { label: string; requiredDocs: string; examples: string }> = {
  "Warehouse & Logistics": {
    label: "Warehouse & Logistics",
    requiredDocs: "Forklift certification, OSHA card, or warehouse safety training certificate",
    examples: "Forklift license, pallet jack certification, OSHA 10/30 card",
  },
  "Skilled Trades": {
    label: "Skilled Trades",
    requiredDocs: "Trade license, contractor license, or relevant certification",
    examples: "Electrician license, plumbing license, general contractor license, HVAC certification",
  },
  "Studio & Engineering": {
    label: "Studio & Engineering",
    requiredDocs: "Audio engineering certification or professional credentials",
    examples: "Pro Tools certification, audio engineering degree, studio apprenticeship completion",
  },
  "Fitness & Training": {
    label: "Fitness & Training",
    requiredDocs: "Personal trainer certification, CPR/AED certification, or coaching credential",
    examples: "NASM, ACE, ISSA certification, CPR/First Aid card",
  },
  "Chefs & Culinary": {
    label: "Chefs & Culinary",
    requiredDocs: "Food handler's permit, ServSafe certification, or culinary arts credential",
    examples: "ServSafe Food Handler card, state food handler's permit, culinary degree or certificate",
  },
};

export const profiles = pgTable("profiles", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  category: text("category").notNull(),
  tier: text("tier").notNull(),
  baseRate: integer("base_rate").notNull(),
  bio: text("bio"),
  media: jsonb("media").$type<string[]>().default([]),
  profileSlug: text("profile_slug").notNull().unique(),
  cashAppHandle: text("cash_app_handle"),
  venmoHandle: text("venmo_handle"),
  zelleHandle: text("zelle_handle"),
  paypalHandle: text("paypal_handle"),
  instagram: text("instagram"),
  tiktok: text("tiktok"),
  youtube: text("youtube"),
  twitter: text("twitter"),
  verified: boolean("verified").default(false),
  isWorker: boolean("is_worker").default(true),
  isPoster: boolean("is_poster").default(false),
  hostDisplayName: text("host_display_name"),
  defaultVenue: text("default_venue"),
  hostBio: text("host_bio"),
  showReviews: boolean("show_reviews").default(true),
  plan: text("plan").default("free"),
  visibility: text("visibility").default("public"),
  stripeAccountId: text("stripe_account_id"),
  stripeAccountStatus: text("stripe_account_status").default("not_connected"),
});

export const PAYMENT_STRUCTURES = ["full_upfront", "split_50_50"] as const;

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  postType: text("post_type").default("gig"),
  title: text("title").notNull(),
  category: text("category").notNull(),
  tier: text("tier").notNull(),
  pay: integer("pay").notNull(),
  venue: text("venue"),
  address: text("address"),
  fullAddress: text("full_address"),
  date: text("date"),
  promoterName: text("promoter_name").notNull(),
  verified: boolean("verified").default(false),
  media: jsonb("media").$type<string[]>().default([]),
  boostLevel: text("boost_level").default("None"),
  boostExpiresAt: timestamp("boost_expires_at"),
  nsfw: boolean("nsfw").default(false),
  paymentStructure: text("payment_structure").default("full_upfront"),
  description: text("description"),
  contactInfo: text("contact_info"),
  recurring: boolean("recurring").default(false),
  directions: text("directions"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const applications = pgTable("applications", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull(),
  applicantId: varchar("applicant_id").notNull(),
  status: text("status").default("pending"),
  posterResponse: text("poster_response"),
  createdAt: timestamp("created_at").defaultNow(),
  respondedAt: timestamp("responded_at"),
});

export const ESCROW_STATUSES = ["none", "authorized", "captured", "cancelled", "refunded"] as const;

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  postId: integer("post_id"),
  workerSlug: text("worker_slug"),
  buyerUid: varchar("buyer_uid").notNull(),
  tier: text("tier").notNull(),
  basePay: integer("base_pay").notNull(),
  platformFee: integer("platform_fee").notNull(),
  boost: text("boost").default("None"),
  boostFee: integer("boost_fee").default(0),
  totalAmount: integer("total_amount").notNull(),
  status: text("status").default("pending_payment"),
  paymentMethod: text("payment_method").default("external"),
  stripeSessionId: text("stripe_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  paymentStructure: text("payment_structure").default("full_upfront"),
  depositAmount: integer("deposit_amount"),
  finalAmount: integer("final_amount"),
  depositStatus: text("deposit_status"),
  finalStatus: text("final_status"),
  depositStripeSessionId: text("deposit_stripe_session_id"),
  finalStripeSessionId: text("final_stripe_session_id"),
  escrowStatus: text("escrow_status").default("none"),
  escrowAuthorizedAt: timestamp("escrow_authorized_at"),
  escrowCapturedAt: timestamp("escrow_captured_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const credits = pgTable("credits", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(),
  balance: integer("balance").notNull().default(3),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const creditLogs = pgTable("credit_logs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  action: text("action").notNull(),
  amount: integer("amount").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const verificationRequests = pgTable("verification_requests", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  idImagePath: text("id_image_path").notNull(),
  selfieImagePath: text("selfie_image_path"),
  status: text("status").default("pending"),
  adminNotes: text("admin_notes"),
  ageConfirmed: boolean("age_confirmed").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  fromUserId: varchar("from_user_id").notNull(),
  toUserId: varchar("to_user_id").notNull(),
  content: text("content").notNull(),
  read: boolean("read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const professionalVerifications = pgTable("professional_verifications", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  category: text("category").notNull(),
  licenseType: text("license_type").notNull(),
  licenseNumber: text("license_number"),
  issuingAuthority: text("issuing_authority"),
  expirationDate: text("expiration_date"),
  documentPath: text("document_path").notNull(),
  businessName: text("business_name"),
  status: text("status").default("pending"),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at").defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
});

export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  reviewerUserId: varchar("reviewer_user_id").notNull(),
  targetProfileId: integer("target_profile_id").notNull(),
  targetType: text("target_type").notNull(),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const follows = pgTable("follows", {
  id: serial("id").primaryKey(),
  followerUserId: varchar("follower_user_id").notNull(),
  followedUserId: varchar("followed_user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  linkUrl: text("link_url"),
  read: boolean("read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const tosAcceptances = pgTable("tos_acceptances", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(),
  acceptedAt: timestamp("accepted_at").defaultNow(),
  tosVersion: text("tos_version").default("1.0"),
});

export const DOCUMENT_TYPES = ["license", "certification", "insurance", "id_document", "resume", "portfolio", "other"] as const;

export const userDocuments = pgTable("user_documents", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  docType: text("doc_type").notNull(),
  filePath: text("file_path").notNull(),
  description: text("description"),
  shareToken: varchar("share_token"),
  shareExpiresAt: timestamp("share_expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserDocumentSchema = createInsertSchema(userDocuments).omit({ id: true, createdAt: true, shareToken: true, shareExpiresAt: true });
export const insertReviewSchema = createInsertSchema(reviews).omit({ id: true, createdAt: true });
export const insertFollowSchema = createInsertSchema(follows).omit({ id: true, createdAt: true });
export const insertNotificationSchema = createInsertSchema(notifications).omit({ id: true, createdAt: true, read: true });
export const insertProfileSchema = createInsertSchema(profiles).omit({ id: true });
export const insertPostSchema = createInsertSchema(posts).omit({ id: true, createdAt: true });
export const insertBookingSchema = createInsertSchema(bookings).omit({ id: true, createdAt: true });
export const insertCreditSchema = createInsertSchema(credits).omit({ id: true, updatedAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true, read: true });
export const insertVerificationSchema = createInsertSchema(verificationRequests).omit({ id: true, createdAt: true, status: true, adminNotes: true, reviewedAt: true });
export const insertApplicationSchema = createInsertSchema(applications).omit({ id: true, createdAt: true, status: true, posterResponse: true, respondedAt: true });
export const insertProfessionalVerificationSchema = createInsertSchema(professionalVerifications).omit({ id: true, createdAt: true, status: true, adminNotes: true, reviewedAt: true });

export type Profile = typeof profiles.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Credit = typeof credits.$inferSelect;
export type CreditLog = typeof creditLogs.$inferSelect;
export type VerificationRequest = typeof verificationRequests.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type TosAcceptance = typeof tosAcceptances.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type ProfessionalVerification = typeof professionalVerifications.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Follow = typeof follows.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type UserDocument = typeof userDocuments.$inferSelect;

export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type InsertPost = z.infer<typeof insertPostSchema>;
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type InsertVerification = z.infer<typeof insertVerificationSchema>;
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type InsertProfessionalVerification = z.infer<typeof insertProfessionalVerificationSchema>;
export type InsertUserDocument = z.infer<typeof insertUserDocumentSchema>;
export type InsertReview = z.infer<typeof insertReviewSchema>;
export type InsertFollow = z.infer<typeof insertFollowSchema>;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

export type CreateProfileRequest = InsertProfile;
export type UpdateProfileRequest = Partial<InsertProfile>;
export type CreatePostRequest = InsertPost;
export type UpdatePostRequest = Partial<InsertPost>;
export type ProfileResponse = Profile;
export type PostResponse = Post;
