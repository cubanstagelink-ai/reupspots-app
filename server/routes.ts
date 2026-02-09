import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { insertProfileSchema, insertProfessionalVerificationSchema, ADMIN_EMAILS, BOOST_FEES, CREDIT_COSTS, PLATFORM_FEE_PERCENT, LICENSED_CATEGORIES, ALL_EVENT_CATEGORIES, verificationRequests, messages, tosAcceptances, profiles, type InsertMessage, type InsertVerification, type Post, type Booking } from "@shared/schema";
import { calculateTotal, getBoostExpiry } from "@shared/pricing";
import { getPostCreditCost, getEventCreditCost, getBoostCreditCost, getApplyCreditCost, canAfford, INITIAL_CREDITS } from "@shared/credits";
import { getPlanDetails, canUseBoosts, hasUnlimitedPosts } from "@shared/subscriptions";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { sql } from "drizzle-orm";
import { db } from "./db";

function getUserId(req: any): string {
  return (req.user as any).claims.sub;
}

function getUserEmail(req: any): string | undefined {
  return (req.user as any)?.claims?.email || (req.user as any)?.email;
}

function isAdmin(req: any): boolean {
  const email = getUserEmail(req);
  return !!email && ADMIN_EMAILS.includes(email);
}

async function ensureCredits(userId: string) {
  let credit = await storage.getCredits(userId);
  if (!credit) {
    credit = await storage.initCredits(userId, INITIAL_CREDITS);
  }
  return credit;
}

async function getUserPlan(userId: string): Promise<string> {
  const profile = await storage.getProfileByUserId(userId);
  return profile?.plan || "free";
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);

  // =====================
  // POSTS
  // =====================

  app.get(api.posts.list.path, async (req, res) => {
    const includeNsfw = req.query.includeNsfw === "true";
    let isVerified = false;
    if (includeNsfw && req.isAuthenticated()) {
      const userId = getUserId(req);
      const verifications = await storage.getVerificationsByUser(userId);
      isVerified = verifications.some(v => v.status === "approved" && v.ageConfirmed);
    }
    const filters = {
      search: req.query.search as string,
      category: req.query.category as string,
      sortBy: req.query.sortBy as "Newest" | "Pay",
      includeNsfw: includeNsfw && isVerified,
      postType: (req.query.postType as string) || "all",
    };
    const posts = await storage.getPosts(filters);
    const sanitized = posts.map(({ fullAddress, ...rest }: Post) => rest);
    res.json(sanitized);
  });

  app.post(api.posts.create.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const input = api.posts.create.input.parse(req.body);
      const userId = getUserId(req);
      const plan = await getUserPlan(userId);

      const isEvent = input.postType === "event";

      if (isEvent) {
        const validEventCategories: readonly string[] = ALL_EVENT_CATEGORIES;
        if (!validEventCategories.includes(input.category)) {
          return res.status(400).json({
            message: `Invalid event category: ${input.category}. Please select a valid event category.`,
          });
        }
        if (input.category === "Adult Club Event") {
          input.nsfw = true;
        }
      }

      if (input.nsfw || input.category === "Adult/NSFW" || input.category === "Adult Club Event") {
        const verifications = await storage.getVerificationsByUser(userId);
        const isAgeVerified = verifications.some(v => v.status === "approved" && v.ageConfirmed);
        if (!isAgeVerified) {
          return res.status(400).json({
            message: "Age-verified ID required to post Adult/NSFW content. Complete ID verification first.",
          });
        }
        input.nsfw = true;
      }

      if (!isEvent && LICENSED_CATEGORIES[input.category]) {
        const proVerification = await storage.getProfessionalVerificationByUserAndCategory(userId, input.category);
        if (!proVerification) {
          return res.status(400).json({
            message: `Professional verification required to post in ${input.category}. Submit your license or certification first.`,
            requiresProfessionalVerification: true,
            category: input.category,
          });
        }
      }

      if (input.boostLevel && input.boostLevel !== "None" && !canUseBoosts(plan)) {
        return res.status(400).json({
          message: "Boosts require a Pro or Elite plan.",
        });
      }

      const isNsfwEvent = isEvent && (input.nsfw || input.category === "Adult Club Event");
      const postCost = isEvent ? getEventCreditCost(isNsfwEvent) : getPostCreditCost(input.tier);
      const boostCost = getBoostCreditCost(input.boostLevel || "None");
      const totalCost = postCost + boostCost;

      if (!hasUnlimitedPosts(plan)) {
        const credit = await ensureCredits(userId);
        if (!canAfford(credit.balance, totalCost, plan)) {
          return res.status(400).json({
            message: `Insufficient credits. Need ${totalCost}, have ${credit.balance}.`,
          });
        }
        const actionLabel = isEvent ? "create_event" : "create_post";
        const desc = isEvent
          ? `Posted event: ${input.title} (${input.category}, boost: ${input.boostLevel || "None"})`
          : `Created post: ${input.title} (tier: ${input.tier}, boost: ${input.boostLevel || "None"})`;
        await storage.deductCredits(userId, totalCost, actionLabel, desc);
      }

      const boostExpiry = getBoostExpiry(input.boostLevel || "None");

      const post = await storage.createPost({
        ...input,
        userId,
        boostExpiresAt: boostExpiry,
      });

      try {
        const followers = await storage.getFollowersByUser(userId);
        const notifTitle = isEvent ? "New Event" : "New Opportunity";
        const notifMessage = isEvent
          ? `${input.promoterName} posted an event: "${input.title}" (${input.category})`
          : `${input.promoterName} posted: "${input.title}" (${input.category}) - $${input.pay}`;
        for (const follower of followers) {
          await storage.createNotification({
            userId: follower.followerUserId,
            type: "new_post",
            title: notifTitle,
            message: notifMessage,
            linkUrl: `/opportunity/${post.id}`,
          });
        }
      } catch (notifErr) {
        console.error("Failed to create notifications for followers:", notifErr);
      }

      res.status(201).json(post);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  // =====================
  // PROFILES
  // =====================

  app.get(api.profiles.list.path, async (req, res) => {
    let viewerCategory: string | undefined;
    let canViewNsfw = false;
    let hasProfile = false;
    let nsfwBlocked = false;
    let viewerPostCategories: string[] = [];
    let allowedCategories: string[] = [];
    let categoryGroupNames: string[] = [];

    if (req.isAuthenticated()) {
      const userId = getUserId(req);
      const viewerProfile = await storage.getProfileByUserId(userId);
      if (viewerProfile) {
        hasProfile = true;
        viewerCategory = viewerProfile.category;

        if (viewerCategory === "Adult/NSFW") {
          const verifications = await storage.getVerificationsByUser(userId);
          canViewNsfw = verifications.some(v => v.status === "approved" && v.ageConfirmed);
          if (!canViewNsfw) {
            nsfwBlocked = true;
          }
        }
      }

      const viewerPosts = await storage.getPostsByUserId(userId);
      viewerPostCategories = Array.from(new Set(viewerPosts.map(p => p.category)));

      const { getRelatedCategories, getCategoryGroupName } = await import("@shared/schema");

      if (viewerPostCategories.length > 0) {
        const expandedSet = new Set<string>();
        const groupNameSet = new Set<string>();
        for (const postCat of viewerPostCategories) {
          if (postCat !== "Adult/NSFW" && postCat !== "Other") {
            for (const related of getRelatedCategories(postCat)) {
              expandedSet.add(related);
            }
            const gName = getCategoryGroupName(postCat);
            if (gName) groupNameSet.add(gName);
          } else {
            expandedSet.add(postCat);
          }
        }
        allowedCategories = Array.from(expandedSet);
        categoryGroupNames = Array.from(groupNameSet);
      } else if (viewerCategory && viewerCategory !== "Adult/NSFW" && viewerCategory !== "Other") {
        allowedCategories = getRelatedCategories(viewerCategory);
        const gName = getCategoryGroupName(viewerCategory);
        if (gName) categoryGroupNames = [gName];
      }
    }

    if (nsfwBlocked) {
      res.json({ profiles: [], viewerCategory: "Adult/NSFW", hasProfile: true, nsfwBlocked: true, allowedCategories: [], categoryGroupName: null });
      return;
    }

    const viewerUserId = req.isAuthenticated() ? getUserId(req) : undefined;
    const allProfiles = await storage.getProfiles({
      allowedCategories: allowedCategories.length > 0 ? allowedCategories : undefined,
      category: allowedCategories.length > 0 ? undefined : viewerCategory,
      includeNsfw: canViewNsfw,
      viewerPostCategories,
      viewerUserId,
    });
    const sanitized = allProfiles.map(p => ({
      ...p,
      cashAppHandle: undefined,
      venmoHandle: undefined,
      zelleHandle: undefined,
      paypalHandle: undefined,
    }));
    res.json({
      profiles: sanitized,
      viewerCategory: viewerCategory || null,
      hasProfile,
      nsfwBlocked: false,
      allowedCategories,
      categoryGroupName: categoryGroupNames.length > 0 ? categoryGroupNames.join(" + ") : null,
    });
  });

  app.get(api.profiles.getBySlug.path, async (req, res) => {
    const profile = await storage.getProfileBySlug(req.params.slug);
    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    if (profile.visibility === "category_only") {
      let canView = false;
      if (req.isAuthenticated()) {
        const viewerId = getUserId(req);
        if (viewerId === profile.userId) {
          canView = true;
        } else {
          const viewerPosts = await storage.getPostsByUserId(viewerId);
          canView = viewerPosts.some(p => p.category === profile.category);
        }
      }
      if (!canView) {
        return res.status(403).json({ message: "This profile is only visible to hosts with matching opportunities." });
      }
    }

    const sanitized = {
      ...profile,
      cashAppHandle: undefined,
      venmoHandle: undefined,
      zelleHandle: undefined,
      paypalHandle: undefined,
    };
    res.json(sanitized);
  });

  app.get(api.me.get.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const profile = await storage.getProfileByUserId(userId);
    const credit = await ensureCredits(userId);
    res.json({
      user: req.user,
      profile: profile || null,
      credits: credit,
    });
  });

  app.post(api.profiles.create.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const input = insertProfileSchema.parse(req.body);
      const userId = getUserId(req);

      const existing = await storage.getProfileByUserId(userId);
      let profile;
      if (existing) {
        profile = await storage.updateProfile(userId, input);
      } else {
        profile = await storage.createProfile({ ...input, userId });
        await ensureCredits(userId);
      }
      res.status(201).json(profile);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  // =====================
  // APPLICATIONS
  // =====================

  app.post(api.applications.create.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const input = api.applications.create.input.parse(req.body);
      const applicantId = getUserId(req);

      const post = await storage.getPost(input.postId);
      if (!post) {
        return res.status(404).json({ message: "Opportunity not found" });
      }

      if (post.nsfw) {
        const verifications = await storage.getVerificationsByUser(applicantId);
        const isAgeVerified = verifications.some(v => v.status === "approved" && v.ageConfirmed);
        if (!isAgeVerified) {
          return res.status(400).json({
            message: "Age-verified ID required to apply for Adult/NSFW opportunities.",
          });
        }
      }

      const existing = await storage.getApplicationByPostAndApplicant(input.postId, applicantId);
      if (existing) {
        return res.status(400).json({ message: "You have already applied to this opportunity." });
      }

      if (post.userId === applicantId) {
        return res.status(400).json({ message: "You cannot apply to your own post." });
      }

      const plan = await getUserPlan(applicantId);
      const applyCost = getApplyCreditCost();
      const credit = await ensureCredits(applicantId);
      if (!canAfford(credit.balance, applyCost, plan)) {
        return res.status(400).json({
          message: `Insufficient credits. Need ${applyCost} credit to apply.`,
        });
      }
      await storage.deductCredits(applicantId, applyCost, "apply", `Applied to: ${post.title}`);

      const application = await storage.createApplication({
        postId: input.postId,
        applicantId,
      });
      res.status(201).json(application);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.errors[0].message });
      }
      throw err;
    }
  });

  app.get(api.applications.mine.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const applicantId = getUserId(req);
    const apps = await storage.getApplicationsByApplicant(applicantId);
    res.json(apps);
  });

  app.get("/api/applications/post/:postId", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const postId = parseInt(req.params.postId);
    const userId = getUserId(req);
    const post = await storage.getPost(postId);
    if (!post || post.userId !== userId) {
      return res.status(403).json({ message: "Not authorized to view applications for this post" });
    }
    const apps = await storage.getApplicationsByPost(postId);
    res.json(apps);
  });

  app.post("/api/applications/:id/respond", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const { status, posterResponse } = api.applications.respond.input.parse(req.body);
      const appId = parseInt(req.params.id);
      const userId = getUserId(req);

      const application = await storage.getApplication(appId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const post = await storage.getPost(application.postId);
      if (!post || post.userId !== userId) {
        return res.status(403).json({ message: "Not authorized to respond to this application" });
      }

      const updated = await storage.updateApplicationStatus(appId, status, posterResponse);
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.errors[0].message });
      }
      throw err;
    }
  });

  // =====================
  // BOOKINGS
  // =====================

  app.post(api.bookings.create.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const input = api.bookings.create.input.parse(req.body);
      const buyerUid = getUserId(req);
      const plan = await getUserPlan(buyerUid);

      const applyCost = getApplyCreditCost();
      if (!canAfford(0, applyCost, plan)) {
        const credit = await ensureCredits(buyerUid);
        if (!canAfford(credit.balance, applyCost, plan)) {
          return res.status(400).json({
            message: `Insufficient credits. Need ${applyCost} credit to book.`,
          });
        }
        await storage.deductCredits(buyerUid, applyCost, "booking", "Booking request created");
      }

      const pricing = calculateTotal({
        basePay: input.basePay,
        tier: input.tier,
        boost: input.boost || "None",
      });

      const totalAmountCents = Math.round(pricing.totalAmount * 100);
      const payStructure = input.paymentStructure || "full_upfront";
      const isSplit = payStructure === "split_50_50";
      const depositAmount = isSplit ? Math.ceil(totalAmountCents / 2) : null;
      const finalAmount = isSplit ? totalAmountCents - Math.ceil(totalAmountCents / 2) : null;

      const booking = await storage.createBooking({
        postId: input.postId || null,
        workerSlug: input.workerSlug || null,
        buyerUid,
        tier: input.tier,
        basePay: input.basePay,
        platformFee: Math.round(pricing.tierFee * 100),
        boost: input.boost || "None",
        boostFee: Math.round(pricing.boostFee * 100),
        totalAmount: totalAmountCents,
        status: "pending_payment",
        paymentStructure: payStructure,
        depositAmount,
        finalAmount,
        depositStatus: isSplit ? "pending" : null,
        finalStatus: isSplit ? "pending" : null,
      });

      res.status(201).json(booking);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.get(api.bookings.myBookings.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const myBookings = await storage.getBookingsByBuyer(userId);
    res.json(myBookings);
  });

  app.post("/api/bookings/:id/mark-paid", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const bookingId = parseInt(req.params.id);
    const booking = await storage.getBooking(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const userId = getUserId(req);
    if (booking.buyerUid !== userId) {
      return res.status(403).json({ message: "Not your booking" });
    }

    if (booking.paymentStructure === "split_50_50") {
      const installment = req.body?.installment as "deposit" | "final" | undefined;
      if (!installment || !["deposit", "final"].includes(installment)) {
        return res.status(400).json({ message: "Must specify installment: 'deposit' or 'final'" });
      }
      if (installment === "final" && booking.depositStatus !== "paid") {
        return res.status(400).json({ message: "Deposit must be confirmed before paying the final installment" });
      }
      const updated = await storage.updateBookingInstallment(bookingId, installment, "submitted");
      return res.json(updated);
    }

    const updated = await storage.updateBookingStatus(bookingId, "payment_submitted");
    res.json(updated);
  });

  app.post("/api/bookings/:id/confirm", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isAdmin(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }

    const bookingId = parseInt(req.params.id);
    const booking = await storage.getBooking(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.paymentStructure === "split_50_50") {
      const installment = req.body?.installment as "deposit" | "final" | undefined;
      if (installment && ["deposit", "final"].includes(installment)) {
        const updated = await storage.updateBookingInstallment(bookingId, installment, "paid");
        return res.json(updated);
      }
    }

    const updated = await storage.updateBookingStatus(bookingId, "confirmed");
    res.json(updated);
  });

  app.post("/api/bookings/:id/cancel", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const bookingId = parseInt(req.params.id);
    const booking = await storage.getBooking(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const userId = getUserId(req);
    if (booking.buyerUid !== userId && !isAdmin(req)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const updated = await storage.updateBookingStatus(bookingId, "cancelled");
    res.json(updated);
  });

  app.get(api.bookings.all.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isAdmin(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }
    const all = await storage.getAllBookings();
    res.json(all);
  });

  // =====================
  // CREDITS
  // =====================

  app.get(api.credits.get.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const credit = await ensureCredits(userId);
    res.json(credit);
  });

  app.get(api.credits.logs.path, async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const logs = await storage.getCreditLogs(userId);
    res.json(logs);
  });

  // =====================
  // BOOKING PAYMENT REVEAL
  // =====================

  app.get("/api/bookings/:id/payment-info", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const bookingId = parseInt(req.params.id);
    const booking = await storage.getBooking(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const userId = getUserId(req);
    if (booking.buyerUid !== userId && !isAdmin(req)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (!booking.workerSlug) {
      return res.json({ cashAppHandle: null });
    }

    const workerProfile = await storage.getProfileBySlug(booking.workerSlug);
    if (!workerProfile?.cashAppHandle) {
      return res.json({ cashAppHandle: null });
    }

    res.json({ cashAppHandle: workerProfile.cashAppHandle });
  });

  // =====================
  // OBJECT STORAGE
  // =====================
  registerObjectStorageRoutes(app);

  // =====================
  // VERIFICATION
  // =====================

  app.post("/api/verification", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const { idImagePath, selfieImagePath } = req.body;
      if (!idImagePath) {
        return res.status(400).json({ message: "idImagePath is required" });
      }
      const verification = await storage.createVerificationRequest({
        userId,
        idImagePath,
        selfieImagePath: selfieImagePath || null,
      });
      res.status(201).json(verification);
    } catch (err) {
      res.status(500).json({ message: "Failed to create verification request" });
    }
  });

  app.get("/api/verification", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const verifications = await storage.getVerificationsByUser(userId);
    res.json(verifications);
  });

  app.get("/api/admin/verifications", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isAdmin(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }
    const verifications = await storage.getAllVerificationRequests();
    res.json(verifications);
  });

  app.post("/api/admin/verifications/:id/review", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isAdmin(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }
    try {
      const id = parseInt(req.params.id);
      const { status, adminNotes } = req.body;
      if (!status || !["approved", "rejected"].includes(status)) {
        return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
      }
      const updated = await storage.updateVerificationStatus(id, status, adminNotes);
      if (!updated) {
        return res.status(404).json({ message: "Verification request not found" });
      }
      if (status === "approved") {
        const userVerifications = await storage.getVerificationsByUser(updated.userId);
        if (userVerifications.length > 0) {
          await storage.updateProfile(updated.userId, { verified: true });
        }
      }
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: "Failed to review verification request" });
    }
  });

  // =====================
  // PROFESSIONAL VERIFICATION
  // =====================

  app.post("/api/professional-verification", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const input = insertProfessionalVerificationSchema.parse({ ...req.body, userId });
      if (!LICENSED_CATEGORIES[input.category]) {
        return res.status(400).json({ message: "This category does not require professional verification" });
      }
      const verification = await storage.createProfessionalVerification(input);
      res.status(201).json(verification);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      }
      res.status(500).json({ message: "Failed to create professional verification request" });
    }
  });

  app.get("/api/professional-verification", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const verifications = await storage.getProfessionalVerificationsByUser(userId);
    res.json(verifications);
  });

  app.get("/api/professional-verification/check/:category", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const category = decodeURIComponent(req.params.category);
    if (!LICENSED_CATEGORIES[category]) {
      return res.json({ required: false, approved: false });
    }
    const approved = await storage.getProfessionalVerificationByUserAndCategory(userId, category);
    const allForCategory = await storage.getProfessionalVerificationsByUser(userId);
    const pending = allForCategory.find(v => v.category === category && v.status === "pending");
    res.json({
      required: true,
      approved: !!approved,
      pending: !!pending,
      categoryInfo: LICENSED_CATEGORIES[category],
    });
  });

  app.get("/api/admin/professional-verifications", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isAdmin(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }
    const verifications = await storage.getAllProfessionalVerifications();
    res.json(verifications);
  });

  app.post("/api/admin/professional-verifications/:id/review", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isAdmin(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }
    try {
      const id = parseInt(req.params.id);
      const { status, adminNotes } = req.body;
      if (!status || !["approved", "rejected"].includes(status)) {
        return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
      }
      const updated = await storage.updateProfessionalVerificationStatus(id, status, adminNotes);
      if (!updated) {
        return res.status(404).json({ message: "Professional verification request not found" });
      }
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: "Failed to review professional verification request" });
    }
  });

  // =====================
  // PRIVATE DOCUMENT VAULT
  // =====================

  app.get("/api/documents", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const docs = await storage.getDocumentsByUser(userId);
      res.json(docs);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch documents" });
    }
  });

  app.post("/api/documents", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const { name, docType, filePath, description } = req.body;

      if (!name || !docType || !filePath) {
        return res.status(400).json({ message: "name, docType, and filePath are required" });
      }

      const doc = await storage.createDocument({
        userId,
        name,
        docType,
        filePath,
        description: description || null,
      });
      res.status(201).json(doc);
    } catch (err) {
      res.status(500).json({ message: "Failed to upload document" });
    }
  });

  app.delete("/api/documents/:id", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const docId = Number(req.params.id);
      const doc = await storage.getDocument(docId);

      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      if (doc.userId !== userId) {
        return res.status(403).json({ message: "Not your document" });
      }

      await storage.deleteDocument(docId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ message: "Failed to delete document" });
    }
  });

  app.post("/api/documents/:id/share", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const docId = Number(req.params.id);
      const doc = await storage.getDocument(docId);

      if (!doc) {
        return res.status(404).json({ message: "Document not found" });
      }
      if (doc.userId !== userId) {
        return res.status(403).json({ message: "Not your document" });
      }

      const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const updated = await storage.createShareLink(docId, token, expiresAt);
      const appUrl = process.env.APP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
      const shareUrl = `${appUrl}/api/documents/shared/${token}`;

      res.json({ shareUrl, expiresAt, token });
    } catch (err) {
      res.status(500).json({ message: "Failed to create share link" });
    }
  });

  app.get("/api/documents/shared/:token", async (req, res) => {
    try {
      const doc = await storage.getDocumentByShareToken(req.params.token);
      if (!doc) {
        return res.status(404).json({ message: "Document not found or link expired" });
      }

      if (doc.shareExpiresAt && new Date(doc.shareExpiresAt) < new Date()) {
        return res.status(410).json({ message: "Share link has expired" });
      }

      res.json({
        name: doc.name,
        docType: doc.docType,
        description: doc.description,
        filePath: doc.filePath,
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to access shared document" });
    }
  });

  // =====================
  // ADMIN STATS
  // =====================

  app.get("/api/admin/stats", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isAdmin(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }
    try {
      const allPosts = await storage.getPosts();
      const allBookings = await storage.getAllBookings();
      const allVerifications = await storage.getAllVerificationRequests();
      const allProfVerifications = await storage.getAllProfessionalVerifications();

      const totalPosts = allPosts.length;
      const activePosts = allPosts.filter((p: Post) => !p.boostExpiresAt || new Date(p.boostExpiresAt) > new Date()).length;
      const totalBookings = allBookings.length;
      const pendingBookings = allBookings.filter(b => b.status === "pending_payment").length;
      const confirmedBookings = allBookings.filter(b => b.status === "confirmed").length;
      const pendingVerifications = allVerifications.filter(v => v.status === "pending").length;
      const approvedVerifications = allVerifications.filter(v => v.status === "approved").length;
      const pendingProfVerifications = allProfVerifications.filter(v => v.status === "pending").length;

      const categoryBreakdown: Record<string, number> = {};
      allPosts.forEach((p: Post) => {
        categoryBreakdown[p.category] = (categoryBreakdown[p.category] || 0) + 1;
      });

      const recentPosts = allPosts
        .sort((a: Post, b: Post) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())
        .slice(0, 10)
        .map(({ fullAddress, ...rest }: Post) => rest);

      const recentBookings = allBookings
        .sort((a: Booking, b: Booking) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())
        .slice(0, 10);

      res.json({
        totalPosts,
        activePosts,
        totalBookings,
        pendingBookings,
        confirmedBookings,
        pendingVerifications,
        approvedVerifications,
        pendingProfVerifications,
        categoryBreakdown,
        recentPosts,
        recentBookings,
        totalVerifications: allVerifications.length,
        totalProfVerifications: allProfVerifications.length,
      });
    } catch (err) {
      console.error("Failed to get admin stats:", err);
      res.status(500).json({ message: "Failed to load admin stats" });
    }
  });

  // =====================
  // POST DETAIL
  // =====================

  app.get("/api/posts/:id", async (req, res) => {
    const postId = parseInt(req.params.id);
    const post = await storage.getPost(postId);
    if (!post) {
      return res.status(404).json({ message: "Opportunity not found" });
    }
    let canSeeFullAddress = false;
    if (req.isAuthenticated()) {
      const viewerId = getUserId(req);
      if (viewerId === post.userId) {
        canSeeFullAddress = true;
      } else {
        const apps = await storage.getApplicationsByApplicant(viewerId);
        canSeeFullAddress = apps.some(a => a.postId === postId && a.status === "accepted");
      }
    }
    if (!canSeeFullAddress) {
      const { fullAddress, ...sanitized } = post;
      return res.json(sanitized);
    }
    res.json(post);
  });

  // =====================
  // POSTER PROFILES (users who post opportunities)
  // =====================

  app.get("/api/poster-profile/:userId", async (req, res) => {
    const userId = req.params.userId;
    const profile = await storage.getProfileByUserId(userId);
    const userPosts = await storage.getPostsByUserId(userId);
    if (!profile && userPosts.length === 0) {
      return res.status(404).json({ message: "Poster not found" });
    }
    let reviewSummary = { likes: 0, dislikes: 0, total: 0 };
    let posterReviews: any[] = [];
    if (profile) {
      reviewSummary = await storage.getReviewSummary(profile.id, "poster");
      posterReviews = await storage.getReviewsByProfile(profile.id, "poster");
    }
    const posterName = profile?.displayName || (userPosts.length > 0 ? userPosts[0].promoterName : "Unknown Poster");
    res.json({
      userId,
      profile: profile ? {
        id: profile.id,
        displayName: profile.displayName,
        bio: profile.bio,
        category: profile.category,
        verified: profile.verified,
        media: profile.media,
        instagram: profile.instagram,
        tiktok: profile.tiktok,
        youtube: profile.youtube,
        twitter: profile.twitter,
      } : null,
      posterName,
      posts: userPosts.map(({ fullAddress, ...rest }: Post) => rest),
      reviews: posterReviews,
      reviewSummary,
    });
  });

  // =====================
  // FOLLOWS & NOTIFICATIONS
  // =====================

  app.get("/api/posters", async (req, res) => {
    const allPosts = await storage.getPosts();
    const posterUserIds = Array.from(new Set(allPosts.map(p => p.userId)));
    const posters = await Promise.all(posterUserIds.map(async (uid) => {
      const profile = await storage.getProfileByUserId(uid);
      const userPosts = await storage.getPostsByUserId(uid);
      const categories = Array.from(new Set(userPosts.map(p => p.category)));
      const followerCount = await storage.getFollowerCount(uid);
      let reviewSummary = { likes: 0, dislikes: 0, total: 0 };
      if (profile) {
        reviewSummary = await storage.getReviewSummary(profile.id, "poster");
      }
      return {
        userId: uid,
        name: profile?.displayName || (userPosts[0]?.promoterName || "Unknown"),
        bio: profile?.bio || null,
        verified: profile?.verified || false,
        categories,
        postCount: userPosts.length,
        followerCount,
        reviewSummary,
        profileId: profile?.id || null,
      };
    }));
    res.json(posters);
  });

  app.post("/api/follows", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const followerUserId = getUserId(req);
    const { followedUserId } = req.body;
    if (!followedUserId) {
      return res.status(400).json({ message: "followedUserId is required" });
    }
    if (followerUserId === followedUserId) {
      return res.status(400).json({ message: "Cannot follow yourself" });
    }
    const already = await storage.isFollowing(followerUserId, followedUserId);
    if (already) {
      return res.status(400).json({ message: "Already following" });
    }
    const follow = await storage.createFollow({ followerUserId, followedUserId });
    res.status(201).json(follow);
  });

  app.delete("/api/follows/:followedUserId", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const followerUserId = getUserId(req);
    const followedUserId = req.params.followedUserId;
    await storage.deleteFollow(followerUserId, followedUserId);
    res.json({ success: true });
  });

  app.get("/api/follows/mine", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const myFollows = await storage.getFollowsByFollower(userId);
    res.json(myFollows);
  });

  app.get("/api/follows/check/:followedUserId", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.json({ following: false });
    }
    const followerUserId = getUserId(req);
    const following = await storage.isFollowing(followerUserId, req.params.followedUserId);
    res.json({ following });
  });

  app.get("/api/notifications", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const notifs = await storage.getNotificationsByUser(userId);
    res.json(notifs);
  });

  app.get("/api/notifications/unread-count", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.json({ count: 0 });
    }
    const userId = getUserId(req);
    const count = await storage.getUnreadNotificationCount(userId);
    res.json({ count });
  });

  app.post("/api/notifications/:id/read", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const id = parseInt(req.params.id);
    await storage.markNotificationRead(id);
    res.json({ success: true });
  });

  app.post("/api/notifications/read-all", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    await storage.markAllNotificationsRead(userId);
    res.json({ success: true });
  });

  // =====================
  // REVIEWS
  // =====================

  app.post("/api/reviews", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const reviewerUserId = getUserId(req);
      const { targetProfileId, targetType, rating, comment } = req.body;

      if (!targetProfileId || !targetType || rating === undefined) {
        return res.status(400).json({ message: "targetProfileId, targetType, and rating are required" });
      }
      if (!["poster", "talent"].includes(targetType)) {
        return res.status(400).json({ message: "targetType must be 'poster' or 'talent'" });
      }
      if (![1, -1].includes(rating)) {
        return res.status(400).json({ message: "rating must be 1 (like) or -1 (dislike)" });
      }

      const existing = await storage.getReviewByReviewerAndTarget(reviewerUserId, targetProfileId, targetType);
      if (existing) {
        return res.status(400).json({ message: "You have already reviewed this profile" });
      }

      const review = await storage.createReview({
        reviewerUserId,
        targetProfileId,
        targetType,
        rating,
        comment: comment || null,
      });
      res.status(201).json(review);
    } catch (err) {
      res.status(500).json({ message: "Failed to create review" });
    }
  });

  app.get("/api/reviews/:targetType/:profileId", async (req, res) => {
    const targetType = req.params.targetType;
    const profileId = parseInt(req.params.profileId);
    if (!["poster", "talent"].includes(targetType)) {
      return res.status(400).json({ message: "targetType must be 'poster' or 'talent'" });
    }
    const reviewList = await storage.getReviewsByProfile(profileId, targetType);
    const summary = await storage.getReviewSummary(profileId, targetType);
    res.json({ reviews: reviewList, summary });
  });

  // =====================
  // MESSAGES
  // =====================

  app.post("/api/messages", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const fromUserId = getUserId(req);
      const { toUserId, content } = req.body;
      if (!toUserId || !content) {
        return res.status(400).json({ message: "toUserId and content are required" });
      }
      const message = await storage.sendMessage({ fromUserId, toUserId, content });
      res.status(201).json(message);
    } catch (err) {
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  app.get("/api/messages/:partnerId", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const partnerId = req.params.partnerId;
    const conversation = await storage.getConversation(userId, partnerId);
    res.json(conversation);
  });

  app.get("/api/conversations", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const conversations = await storage.getConversationList(userId);
    res.json(conversations);
  });

  app.post("/api/messages/:partnerId/read", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const partnerId = req.params.partnerId;
    await storage.markMessagesRead(partnerId, userId);
    res.json({ success: true });
  });

  // =====================
  // TOS
  // =====================

  app.post("/api/tos/accept", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const acceptance = await storage.acceptTos(userId);
      res.status(201).json(acceptance);
    } catch (err) {
      res.status(500).json({ message: "Failed to accept TOS" });
    }
  });

  app.get("/api/tos/status", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userId = getUserId(req);
    const acceptance = await storage.getTosAcceptance(userId);
    res.json({ accepted: !!acceptance, acceptance: acceptance || null });
  });

  // =====================
  // STRIPE CREDIT PURCHASE
  // =====================

  app.get("/api/stripe/publishable-key", async (req, res) => {
    try {
      const key = await getStripePublishableKey();
      res.json({ publishableKey: key });
    } catch (err) {
      res.status(500).json({ message: "Stripe not configured" });
    }
  });

  app.get("/api/credit-packages", async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT 
          p.id as product_id,
          p.name as product_name,
          p.description as product_description,
          p.metadata as product_metadata,
          pr.id as price_id,
          pr.unit_amount,
          pr.currency
        FROM stripe.products p
        JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
        WHERE p.active = true
        AND p.metadata->>'type' = 'credit_package'
        ORDER BY pr.unit_amount ASC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching credit packages:", err);
      res.json([]);
    }
  });

  app.post("/api/stripe/checkout", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const userId = getUserId(req);
      const { priceId, credits } = req.body;

      if (!priceId || !credits) {
        return res.status(400).json({ message: "Missing priceId or credits" });
      }

      const stripe = await getUncachableStripeClient();

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        success_url: `${req.protocol}://${req.get('host')}/me?purchase=success&credits=${credits}`,
        cancel_url: `${req.protocol}://${req.get('host')}/buy-credits?cancelled=true`,
        metadata: {
          userId,
          credits: String(credits),
        },
      });

      res.json({ url: session.url });
    } catch (err: any) {
      console.error("Checkout error:", err);
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  });

  app.post("/api/stripe/fulfill-credits", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const userId = getUserId(req);
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ message: "Missing sessionId" });
      }

      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== 'paid') {
        return res.status(400).json({ message: "Payment not completed" });
      }

      if (session.metadata?.userId !== userId) {
        return res.status(403).json({ message: "Session does not belong to you" });
      }

      const credits = parseInt(session.metadata?.credits || "0");
      if (credits <= 0) {
        return res.status(400).json({ message: "Invalid credit amount" });
      }

      await ensureCredits(userId);
      await storage.addCredits(userId, credits, "purchase", `Purchased ${credits} credits via Stripe`);

      res.json({ success: true, creditsAdded: credits });
    } catch (err: any) {
      console.error("Fulfill error:", err);
      res.status(500).json({ message: "Failed to fulfill credits" });
    }
  });

  // =====================
  // STRIPE CONNECT (Worker Onboarding & Payments)
  // =====================

  app.post("/api/stripe/connect/create-account", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const email = getUserEmail(req);
      const profile = await storage.getProfileByUserId(userId);
      if (!profile) {
        return res.status(400).json({ message: "Create a profile first" });
      }
      if (profile.stripeAccountId) {
        return res.status(400).json({ message: "Stripe account already exists", accountId: profile.stripeAccountId });
      }

      const stripe = await getUncachableStripeClient();
      const account = await stripe.accounts.create({
        type: "express",
        email: email || undefined,
        metadata: { userId, profileSlug: profile.profileSlug },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      await storage.updateProfile(userId, {
        stripeAccountId: account.id,
        stripeAccountStatus: "pending",
      });

      const appUrl = process.env.APP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: `${appUrl}/my-profile?stripe=refresh`,
        return_url: `${appUrl}/my-profile?stripe=complete`,
        type: "account_onboarding",
      });

      res.json({ url: accountLink.url });
    } catch (err: any) {
      console.error("Stripe Connect create error:", err);
      res.status(500).json({ message: "Failed to create Stripe account" });
    }
  });

  app.get("/api/stripe/connect/account-link", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const profile = await storage.getProfileByUserId(userId);
      if (!profile?.stripeAccountId) {
        return res.status(400).json({ message: "No Stripe account found" });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = process.env.APP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
      const accountLink = await stripe.accountLinks.create({
        account: profile.stripeAccountId,
        refresh_url: `${appUrl}/my-profile?stripe=refresh`,
        return_url: `${appUrl}/my-profile?stripe=complete`,
        type: "account_onboarding",
      });

      res.json({ url: accountLink.url });
    } catch (err: any) {
      console.error("Stripe Connect link error:", err);
      res.status(500).json({ message: "Failed to create account link" });
    }
  });

  app.get("/api/stripe/connect/status", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const profile = await storage.getProfileByUserId(userId);
      if (!profile?.stripeAccountId) {
        return res.json({ connected: false, status: "not_connected" });
      }

      const stripe = await getUncachableStripeClient();
      const account = await stripe.accounts.retrieve(profile.stripeAccountId);

      const isActive = account.charges_enabled && account.payouts_enabled;
      const newStatus = isActive ? "active" : (account.details_submitted ? "pending" : "incomplete");

      if (newStatus !== profile.stripeAccountStatus) {
        await storage.updateProfile(userId, { stripeAccountStatus: newStatus });
      }

      res.json({
        connected: true,
        status: newStatus,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
      });
    } catch (err: any) {
      console.error("Stripe Connect status error:", err);
      res.status(500).json({ message: "Failed to check Stripe status" });
    }
  });

  app.get("/api/stripe/connect/dashboard-link", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const profile = await storage.getProfileByUserId(userId);
      if (!profile?.stripeAccountId) {
        return res.status(400).json({ message: "No Stripe account found" });
      }

      const stripe = await getUncachableStripeClient();
      const loginLink = await stripe.accounts.createLoginLink(profile.stripeAccountId);
      res.json({ url: loginLink.url });
    } catch (err: any) {
      console.error("Stripe dashboard link error:", err);
      res.status(500).json({ message: "Failed to create dashboard link" });
    }
  });

  app.post("/api/stripe/connect/checkout", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ message: "bookingId is required" });
      }

      const booking = await storage.getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      const buyerUid = getUserId(req);
      if (booking.buyerUid !== buyerUid) {
        return res.status(403).json({ message: "Not your booking" });
      }

      if (booking.status !== "pending_payment") {
        return res.status(400).json({ message: "Booking is not awaiting payment" });
      }

      const workerProfile = booking.workerSlug ? await storage.getProfileBySlug(booking.workerSlug) : null;
      if (!workerProfile?.stripeAccountId) {
        return res.status(400).json({ message: "Worker has not connected Stripe. Arrange payment independently." });
      }

      const stripe = await getUncachableStripeClient();
      const workerAccount = await stripe.accounts.retrieve(workerProfile.stripeAccountId);
      if (!workerAccount.charges_enabled) {
        return res.status(400).json({ message: "Worker's Stripe account is not yet fully set up" });
      }

      const totalCents = booking.totalAmount;
      const platformFeeCents = Math.round(totalCents * PLATFORM_FEE_PERCENT / 100);

      const appUrl = process.env.APP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Booking: ${workerProfile.displayName}`,
                description: `${booking.tier} tier booking via ReUpSpots`,
              },
              unit_amount: totalCents,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: platformFeeCents,
          transfer_data: {
            destination: workerProfile.stripeAccountId,
          },
        },
        metadata: {
          bookingId: String(bookingId),
          buyerUid,
          workerSlug: booking.workerSlug || "",
          platformFeePercent: String(PLATFORM_FEE_PERCENT),
        },
        success_url: `${appUrl}/my-profile?booking_paid=${bookingId}`,
        cancel_url: `${appUrl}/profiles/${booking.workerSlug}?payment_cancelled=1`,
      });

      await storage.updateBookingStripeInfo(bookingId, {
        stripeSessionId: session.id,
        paymentMethod: "stripe",
      });

      res.json({ url: session.url });
    } catch (err: any) {
      console.error("Stripe Connect checkout error:", err);
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  });

  app.post("/api/stripe/connect/fulfill", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ message: "bookingId is required" });
      }

      const booking = await storage.getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      if (booking.paymentMethod !== "stripe" || !booking.stripeSessionId) {
        return res.status(400).json({ message: "Not a Stripe booking" });
      }

      if (booking.status === "confirmed") {
        return res.json({ success: true, message: "Already fulfilled" });
      }

      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);

      if (session.payment_status === "paid") {
        await storage.updateBookingStripeInfo(Number(bookingId), {
          status: "confirmed",
          stripePaymentIntentId: session.payment_intent as string,
        });
        return res.json({ success: true, message: "Payment confirmed" });
      }

      res.json({ success: false, message: "Payment not yet completed" });
    } catch (err: any) {
      console.error("Stripe Connect fulfill error:", err);
      res.status(500).json({ message: "Failed to fulfill booking payment" });
    }
  });

  app.get("/api/stripe/connect/earnings", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = getUserId(req);
      const profile = await storage.getProfileByUserId(userId);
      if (!profile) {
        return res.json({ gross: 0, fees: 0, net: 0, bookings: [] });
      }

      const workerBookings = await storage.getBookingsByWorker(profile.profileSlug);
      const confirmedBookings = workerBookings.filter(b => b.status === "confirmed" && b.paymentMethod === "stripe");

      const gross = confirmedBookings.reduce((sum, b) => sum + b.totalAmount, 0);
      const fees = confirmedBookings.reduce((sum, b) => sum + Math.round(b.totalAmount * PLATFORM_FEE_PERCENT / 100), 0);
      const net = gross - fees;

      res.json({
        gross,
        fees,
        net,
        count: confirmedBookings.length,
        feePercent: PLATFORM_FEE_PERCENT,
      });
    } catch (err: any) {
      console.error("Earnings error:", err);
      res.status(500).json({ message: "Failed to get earnings" });
    }
  });

  // =====================
  // ESCROW (PAY & RESERVE)
  // =====================

  app.post("/api/escrow/reserve", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ message: "bookingId is required" });
      }

      const booking = await storage.getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      const buyerUid = getUserId(req);
      if (booking.buyerUid !== buyerUid) {
        return res.status(403).json({ message: "Not your booking" });
      }

      if (booking.status !== "pending_payment") {
        return res.status(400).json({ message: "Booking is not awaiting payment" });
      }

      if (booking.escrowStatus === "authorized") {
        return res.status(400).json({ message: "Payment already reserved in escrow" });
      }

      const stripe = await getUncachableStripeClient();
      const totalCents = booking.totalAmount;

      const appUrl = process.env.APP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_intent_data: {
          capture_method: "manual",
          metadata: {
            bookingId: String(bookingId),
            buyerUid,
            workerSlug: booking.workerSlug || "",
            type: "escrow",
          },
        },
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Escrow Reservation - Booking #${bookingId}`,
              description: "Funds held until gig completion",
            },
            unit_amount: totalCents,
          },
          quantity: 1,
        }],
        success_url: `${appUrl}/profiles/${booking.workerSlug}?escrow=success&bookingId=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/profiles/${booking.workerSlug}?escrow=cancelled`,
      });

      await storage.updateBookingStripeInfo(bookingId, {
        stripeSessionId: session.id,
        paymentMethod: "escrow",
      });

      res.json({ url: session.url });
    } catch (err: any) {
      console.error("Escrow reserve error:", err);
      res.status(500).json({ message: "Failed to create escrow reservation" });
    }
  });

  app.post("/api/escrow/confirm-reservation", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const { bookingId, sessionId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ message: "bookingId is required" });
      }

      const booking = await storage.getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      const buyerUid = getUserId(req);
      if (booking.buyerUid !== buyerUid) {
        return res.status(403).json({ message: "Not your booking" });
      }

      if (booking.escrowStatus === "authorized") {
        return res.json({ success: true, escrowStatus: "authorized", message: "Escrow already confirmed" });
      }

      const stripe = await getUncachableStripeClient();

      const checkoutSessionId = sessionId || booking.stripeSessionId;
      if (!checkoutSessionId) {
        return res.status(400).json({ message: "No checkout session found" });
      }

      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      if (session.payment_status !== "paid" || !session.payment_intent) {
        return res.json({ success: false, message: `Checkout session status: ${session.payment_status}` });
      }

      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status === "requires_capture") {
        await storage.updateBookingStripeInfo(bookingId, {
          stripePaymentIntentId: paymentIntentId,
        });
        await storage.updateBookingEscrow(bookingId, "authorized");
        await storage.updateBookingStatus(bookingId, "payment_submitted");
        return res.json({ success: true, escrowStatus: "authorized", message: "Payment reserved in escrow" });
      }

      res.json({ success: false, message: `Payment intent status: ${paymentIntent.status}` });
    } catch (err: any) {
      console.error("Escrow confirm error:", err);
      res.status(500).json({ message: "Failed to confirm escrow reservation" });
    }
  });

  app.post("/api/escrow/release", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ message: "bookingId is required" });
      }

      const booking = await storage.getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      const userId = getUserId(req);
      if (booking.buyerUid !== userId && !isAdmin(req)) {
        return res.status(403).json({ message: "Only the host or admin can release escrow funds" });
      }

      if (booking.escrowStatus !== "authorized") {
        return res.status(400).json({ message: "No authorized escrow to release" });
      }

      if (!booking.stripePaymentIntentId) {
        return res.status(400).json({ message: "No payment intent found" });
      }

      const stripe = await getUncachableStripeClient();
      await stripe.paymentIntents.capture(booking.stripePaymentIntentId);

      await storage.updateBookingEscrow(bookingId, "captured");
      await storage.updateBookingStatus(bookingId, "confirmed");

      res.json({ success: true, message: "Escrow funds released to talent" });
    } catch (err: any) {
      console.error("Escrow release error:", err);
      res.status(500).json({ message: "Failed to release escrow funds" });
    }
  });

  app.post("/api/escrow/cancel", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(400).json({ message: "bookingId is required" });
      }

      const booking = await storage.getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      const userId = getUserId(req);
      if (booking.buyerUid !== userId && !isAdmin(req)) {
        return res.status(403).json({ message: "Only the host or admin can cancel escrow" });
      }

      if (booking.escrowStatus !== "authorized") {
        return res.status(400).json({ message: "No authorized escrow to cancel" });
      }

      if (!booking.stripePaymentIntentId) {
        return res.status(400).json({ message: "No payment intent found" });
      }

      const stripe = await getUncachableStripeClient();
      await stripe.paymentIntents.cancel(booking.stripePaymentIntentId);

      await storage.updateBookingEscrow(bookingId, "cancelled");
      await storage.updateBookingStatus(bookingId, "cancelled");

      res.json({ success: true, message: "Escrow cancelled and funds returned" });
    } catch (err: any) {
      console.error("Escrow cancel error:", err);
      res.status(500).json({ message: "Failed to cancel escrow" });
    }
  });

  // =====================
  // DAILY VIDEO ROOMS
  // =====================

  app.post("/api/daily/create-room", async (req, res) => {
    try {
      const DAILY_API_KEY = process.env.DAILY_API_KEY;
      if (!DAILY_API_KEY) {
        return res.status(500).json({ ok: false, error: "Daily.co not configured" });
      }

      const { roomName, expMinutes } = req.body ?? {};

      const body: any = {
        name: roomName || undefined,
        properties: {
          enable_chat: true,
          enable_screenshare: true,
          exp: expMinutes ? Math.floor(Date.now() / 1000) + expMinutes * 60 : undefined,
        },
      };

      const cleanBody = JSON.parse(JSON.stringify(body));

      const r = await fetch("https://api.daily.co/v1/rooms", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DAILY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cleanBody),
      });

      const data = await r.json();

      if (!r.ok) {
        return res.status(r.status).json({ ok: false, error: "Daily API error", details: data });
      }

      return res.status(200).json({ ok: true, room: data });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: "Server error creating Daily room", details: err?.message ?? String(err) });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true, message: "Re-Up Spots backend running" });
  });

  // Seeding
  await seedDatabase();

  return httpServer;
}

async function seedDatabase() {
  const existingPosts = await storage.getPosts();
  if (existingPosts.length === 0) {
    const samplePosts = [
      {
        title: "Headline DJ Set - Neon District Rave",
        category: "Music",
        tier: "Projects",
        pay: 350,
        venue: "The Neon District",
        address: "South Loop, Chicago, IL",
        date: "2026-02-14",
        promoterName: "Vortex Events",
        verified: true,
        media: ["https://images.unsplash.com/photo-1571266028243-37160d7f1e5e?w=800"],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_1"
      },
      {
        title: "R&B Vocalist Needed for Studio Session",
        category: "Music",
        tier: "Missions",
        pay: 200,
        venue: "Crystal Sound Studios",
        address: "Near North Side, Chicago, IL",
        date: "2026-02-12",
        promoterName: "Tray Wavez",
        verified: true,
        media: ["https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800"],
        boostLevel: "None",
        userId: "seed_user_2"
      },
      {
        title: "Hip-Hop Dance Crew - Music Video Shoot",
        category: "Dance",
        tier: "Projects",
        pay: 500,
        venue: "Southside Studios",
        address: "Bronzeville, Chicago, IL",
        date: "2026-02-15",
        promoterName: "Nola Visions",
        verified: true,
        media: ["https://images.unsplash.com/photo-1547153760-18fc86324498?w=800"],
        boostLevel: "7 Day Featured" as const,
        userId: "seed_user_3"
      },
      {
        title: "Stand-Up Comedy Open Mic Host",
        category: "Comedy",
        tier: "Tasks",
        pay: 100,
        venue: "The Punchline Lounge",
        address: "Wicker Park, Chicago, IL",
        date: "2026-02-11",
        promoterName: "Big Laugh Collective",
        verified: true,
        media: ["https://images.unsplash.com/photo-1585672535860-252f4625b1f9?w=800"],
        boostLevel: "None",
        userId: "seed_user_4"
      },
      {
        title: "Fashion Show Models - Spring Drop",
        category: "Modeling",
        tier: "Projects",
        pay: 400,
        venue: "The Gallery on State",
        address: "Loop, Chicago, IL",
        date: "2026-02-20",
        promoterName: "Kya Luxe",
        verified: true,
        media: ["https://images.unsplash.com/photo-1509631179647-0177331693ae?w=800"],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_5"
      },
      {
        title: "Background Actor - Indie Film",
        category: "Acting",
        tier: "Slots",
        pay: 75,
        venue: "Lincoln Park Set Location",
        address: "Lincoln Park, Chicago, IL",
        date: "2026-02-13",
        promoterName: "DreamFrame Productions",
        verified: false,
        media: ["https://images.unsplash.com/photo-1485846234645-a62644f84728?w=800"],
        boostLevel: "None",
        userId: "seed_user_6"
      },
      {
        title: "Latin Dance Instructor - Weekly Classes",
        category: "Dance",
        tier: "Missions",
        pay: 125,
        venue: "Ritmo Dance Academy",
        address: "Little Village, Chicago, IL",
        date: "2026-02-10",
        promoterName: "Ritmo Academy",
        verified: true,
        media: ["https://images.unsplash.com/photo-1518834107812-67b0b7c58434?w=800"],
        boostLevel: "None",
        userId: "seed_user_7"
      },
      {
        title: "Live Band for Rooftop Party",
        category: "Music",
        tier: "Projects",
        pay: 600,
        venue: "SkyBar Chicago",
        address: "Loop, Chicago, IL",
        date: "2026-02-22",
        promoterName: "Elevated Events Co",
        verified: true,
        media: ["https://images.unsplash.com/photo-1501386761578-0a55f5f9880d?w=800"],
        boostLevel: "7 Day Featured" as const,
        userId: "seed_user_8"
      },
      {
        title: "Comedian for Corporate Event",
        category: "Comedy",
        tier: "Projects",
        pay: 450,
        venue: "Hyatt Regency Grand Ballroom",
        address: "East Loop, Chicago, IL",
        date: "2026-02-18",
        promoterName: "ClearVision Corp",
        verified: true,
        media: ["https://images.unsplash.com/photo-1527224857830-43a7acc85260?w=800"],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_9"
      },
      {
        title: "Freestyle Rapper - Cypher Battle",
        category: "Music",
        tier: "Chances",
        pay: 0,
        venue: "The Cipher Yard",
        address: "Woodlawn, Chicago, IL",
        date: "2026-02-16",
        promoterName: "BarZ Up",
        verified: true,
        media: ["https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800"],
        boostLevel: "None",
        userId: "seed_user_10"
      },
      {
        title: "Catalog Model - Streetwear Brand",
        category: "Modeling",
        tier: "Missions",
        pay: 250,
        venue: "West Loop Loft Studio",
        address: "West Loop, Chicago, IL",
        date: "2026-02-17",
        promoterName: "GrimeFit Co",
        verified: true,
        media: ["https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=800"],
        boostLevel: "None",
        userId: "seed_user_11"
      },
      {
        title: "Lead Role Auditions - Stage Play",
        category: "Acting",
        tier: "Projects",
        pay: 300,
        venue: "Apollo Theater Chicago",
        address: "Lincoln Park, Chicago, IL",
        date: "2026-02-21",
        promoterName: "Spotlight Stage Co",
        verified: true,
        media: ["https://images.unsplash.com/photo-1503095396549-807759245b35?w=800"],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_12"
      },
      {
        title: "Drummer Needed - Jazz Ensemble",
        category: "Music",
        tier: "Tasks",
        pay: 120,
        venue: "Blue Note Lounge",
        address: "Lakeview, Chicago, IL",
        date: "2026-02-19",
        promoterName: "MidnightJazz",
        verified: false,
        media: ["https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?w=800"],
        boostLevel: "None",
        userId: "seed_user_13"
      },
      {
        title: "Breakdance Battle Judge",
        category: "Dance",
        tier: "Tasks",
        pay: 150,
        venue: "BRKN Ground Arena",
        address: "Gage Park, Chicago, IL",
        date: "2026-02-23",
        promoterName: "BRKN Ground",
        verified: true,
        media: ["https://images.unsplash.com/photo-1508700929628-666bc8bd84ea?w=800"],
        boostLevel: "None",
        userId: "seed_user_14"
      },
      {
        title: "Brand Ambassador - Product Launch",
        category: "Modeling",
        tier: "Slots",
        pay: 100,
        venue: "Navy Pier Event Center",
        address: "Streeterville, Chicago, IL",
        date: "2026-02-24",
        promoterName: "LaunchPad Agency",
        verified: true,
        media: ["https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=800"],
        boostLevel: "None",
        userId: "seed_user_15"
      },
      {
        title: "Braider Needed - Knotless Box Braids",
        category: "Hair & Beauty",
        tier: "Tasks",
        pay: 180,
        venue: "Client Home Visit",
        address: "Bronzeville, Chicago, IL",
        date: "2026-02-25",
        promoterName: "Mya Styles",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_16"
      },
      {
        title: "Barber for Pop-Up Shop Event",
        category: "Barber",
        tier: "Missions",
        pay: 250,
        venue: "Wicker Park Vintage Market",
        address: "Wicker Park, Chicago, IL",
        date: "2026-02-26",
        promoterName: "Fresh Cutz Collective",
        verified: true,
        media: [],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_17"
      },
      {
        title: "Nail Tech - Full Set Gel Manicure",
        category: "Nails",
        tier: "Tasks",
        pay: 85,
        venue: "Mobile Service",
        address: "Hyde Park, Chicago, IL",
        date: "2026-02-27",
        promoterName: "Drip Nails Studio",
        verified: false,
        media: [],
        boostLevel: "None",
        userId: "seed_user_18"
      },
      {
        title: "Grocery & Package Pickup Runner",
        category: "Errands & Tasks",
        tier: "Slots",
        pay: 40,
        venue: "Various Locations",
        address: "Loop Area, Chicago, IL",
        date: "2026-02-28",
        promoterName: "QuickRun Services",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_19"
      },
      {
        title: "Event Companion - Charity Gala",
        category: "Companionship",
        tier: "Projects",
        pay: 300,
        venue: "Four Seasons Hotel",
        address: "Gold Coast, Chicago, IL",
        date: "2026-03-01",
        promoterName: "Verified Host",
        verified: true,
        media: [],
        boostLevel: "7 Day Featured" as const,
        userId: "seed_user_30"
      },
      {
        title: "Math Tutor for SAT Prep",
        category: "Tutoring",
        tier: "Missions",
        pay: 60,
        venue: "Virtual / Zoom",
        address: "Remote",
        date: "2026-03-02",
        promoterName: "BrainBoost Academy",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_31"
      },
      {
        title: "Event Photographer - Birthday Party",
        category: "Photography",
        tier: "Projects",
        pay: 350,
        venue: "Private Venue",
        address: "Gold Coast, Chicago, IL",
        date: "2026-03-03",
        promoterName: "LensKing Media",
        verified: true,
        media: [],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_32"
      },
      {
        title: "DJ for House Party",
        category: "DJ/Audio",
        tier: "Tasks",
        pay: 200,
        venue: "Private Residence",
        address: "Lakeview, Chicago, IL",
        date: "2026-03-04",
        promoterName: "PartyMode Productions",
        verified: false,
        media: [],
        boostLevel: "None",
        userId: "seed_user_33"
      },
      {
        title: "Personal Trainer - 4 Week Program",
        category: "Fitness & Training",
        tier: "Missions",
        pay: 400,
        venue: "FitZone Gym",
        address: "Lakeview, Chicago, IL",
        date: "2026-03-05",
        promoterName: "IronCore Fitness",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_34"
      },
      {
        title: "Warehouse Associate - Overnight Shift",
        category: "Warehouse & Logistics",
        tier: "Tasks",
        pay: 160,
        venue: "Distribution Center",
        address: "Back of the Yards, Chicago, IL",
        date: "2026-03-06",
        promoterName: "SwiftShip Logistics",
        verified: true,
        media: [],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_35"
      },
      {
        title: "Forklift Operator - 2 Day Contract",
        category: "Warehouse & Logistics",
        tier: "Projects",
        pay: 320,
        venue: "Warehouse Facility",
        address: "South Loop, Chicago, IL",
        date: "2026-03-07",
        promoterName: "PrimeCargo Inc",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_36"
      },
      {
        title: "Pallet Jack Operator - Weekend Loading",
        category: "Warehouse & Logistics",
        tier: "Missions",
        pay: 200,
        venue: "Freight Hub",
        address: "Bridgeport, Chicago, IL",
        date: "2026-03-08",
        promoterName: "LoadUp Staffing",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_37"
      },
      {
        title: "Office Deep Clean - After Hours",
        category: "Cleaning & Janitorial",
        tier: "Tasks",
        pay: 120,
        venue: "Office Building",
        address: "West Loop, Chicago, IL",
        date: "2026-03-06",
        promoterName: "SparkleClean Co",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_38"
      },
      {
        title: "Janitorial Crew - Event Cleanup",
        category: "Cleaning & Janitorial",
        tier: "Slots",
        pay: 80,
        venue: "McCormick Place",
        address: "Near South Side, Chicago, IL",
        date: "2026-03-09",
        promoterName: "EventClean Services",
        verified: true,
        media: [],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_39"
      },
      {
        title: "Residential Cleaning - 3 Bedroom Home",
        category: "Cleaning & Janitorial",
        tier: "Missions",
        pay: 150,
        venue: "Client Home",
        address: "Lincoln Square, Chicago, IL",
        date: "2026-03-10",
        promoterName: "FreshSpace Pros",
        verified: false,
        media: [],
        boostLevel: "None",
        userId: "seed_user_40"
      },
      {
        title: "Sales Associate - Pop-Up Sneaker Shop",
        category: "Sales & Retail",
        tier: "Projects",
        pay: 180,
        venue: "Pop-Up Shop",
        address: "Magnificent Mile, Chicago, IL",
        date: "2026-03-07",
        promoterName: "KickDrop Chicago",
        verified: true,
        media: [],
        boostLevel: "7 Day Featured" as const,
        userId: "seed_user_41"
      },
      {
        title: "Retail Help - Weekend Rush Staff",
        category: "Sales & Retail",
        tier: "Tasks",
        pay: 100,
        venue: "Retail Store",
        address: "Loop, Chicago, IL",
        date: "2026-03-08",
        promoterName: "UrbanThreads",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_42"
      },
      {
        title: "Studio Engineer - Rap Recording Session",
        category: "Studio & Engineering",
        tier: "Projects",
        pay: 250,
        venue: "Recording Studio",
        address: "Pilsen, Chicago, IL",
        date: "2026-03-06",
        promoterName: "808 Factory",
        verified: true,
        media: [],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_43"
      },
      {
        title: "Mixing Engineer - 5 Track EP",
        category: "Studio & Engineering",
        tier: "Projects",
        pay: 500,
        venue: "Recording Studio",
        address: "West Town, Chicago, IL",
        date: "2026-03-10",
        promoterName: "Elevated Sound Co",
        verified: true,
        media: [],
        boostLevel: "7 Day Featured" as const,
        userId: "seed_user_44"
      },
      {
        title: "General Helper - Moving Day",
        category: "General Labor",
        tier: "Slots",
        pay: 100,
        venue: "Pickup at Client Location",
        address: "Pilsen, Chicago, IL",
        date: "2026-03-06",
        promoterName: "QuickMove Helpers",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_45"
      },
      {
        title: "Event Setup Crew - Festival Grounds",
        category: "General Labor",
        tier: "Tasks",
        pay: 140,
        venue: "Union Park",
        address: "West Loop, Chicago, IL",
        date: "2026-03-09",
        promoterName: "ChiTown Festivals",
        verified: true,
        media: [],
        boostLevel: "72h Boost" as const,
        userId: "seed_user_46"
      },
      {
        title: "Handyman - Drywall Repair & Painting",
        category: "Skilled Trades",
        tier: "Missions",
        pay: 200,
        venue: "Client Property",
        address: "Bridgeport, Chicago, IL",
        date: "2026-03-07",
        promoterName: "FixIt Right Services",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_47"
      },
      {
        title: "Electrician Assistant - Commercial Job",
        category: "Skilled Trades",
        tier: "Projects",
        pay: 280,
        venue: "Construction Site",
        address: "Fulton Market, Chicago, IL",
        date: "2026-03-08",
        promoterName: "VoltWorks Electric",
        verified: true,
        media: [],
        boostLevel: "None",
        userId: "seed_user_48"
      },
    ];

    for (const post of samplePosts) {
      await storage.createPost(post);
    }

    const sampleProfiles = [
      {
        userId: "seed_user_20",
        displayName: "Dex Marlo",
        category: "Music",
        tier: "Projects",
        baseRate: 200,
        bio: "Producer & DJ spinning underground house and techno. 6 years rocking festivals and warehouse parties across the midwest.",
        profileSlug: "dex-marlo",
        verified: true,
        plan: "pro",
        instagram: "@dexmarlo",
        media: ["https://images.unsplash.com/photo-1571266028243-37160d7f1e5e?w=800"],
      },
      {
        userId: "seed_user_21",
        displayName: "Nyla Reign",
        category: "Dance",
        tier: "Projects",
        baseRate: 175,
        bio: "Contemporary & hip-hop choreographer. Trained at Joffrey. Credits include music videos, live tours, and national competitions.",
        profileSlug: "nyla-reign",
        verified: true,
        plan: "elite",
        instagram: "@nylareign",
        tiktok: "@nyla.reign",
        media: ["https://images.unsplash.com/photo-1547153760-18fc86324498?w=800"],
      },
      {
        userId: "seed_user_22",
        displayName: "Corey Banks",
        category: "Comedy",
        tier: "Missions",
        baseRate: 100,
        bio: "Chicago stand-up veteran. Featured at Zanies, Laugh Factory, and Comedy Bar. Clean or raw sets available.",
        profileSlug: "corey-banks",
        verified: true,
        plan: "pro",
        instagram: "@coreybankscomedy",
        youtube: "@CoreyBanksLive",
        media: ["https://images.unsplash.com/photo-1585672535860-252f4625b1f9?w=800"],
      },
      {
        userId: "seed_user_23",
        displayName: "Zara Knight",
        category: "Modeling",
        tier: "Projects",
        baseRate: 250,
        bio: "Fashion & editorial model. Agency signed. Runway, catalog, and brand campaign experience. 5'10\".",
        profileSlug: "zara-knight",
        verified: true,
        plan: "elite",
        instagram: "@zaraknight",
        tiktok: "@zaraknight_",
        media: ["https://images.unsplash.com/photo-1509631179647-0177331693ae?w=800"],
      },
      {
        userId: "seed_user_24",
        displayName: "Marcus Cole",
        category: "Acting",
        tier: "Missions",
        baseRate: 150,
        bio: "Stage & screen actor. Training at Second City and Steppenwolf. Available for film, commercial, and theater roles.",
        profileSlug: "marcus-cole",
        verified: true,
        plan: "pro",
        instagram: "@marcuscoleacts",
        media: ["https://images.unsplash.com/photo-1503095396549-807759245b35?w=800"],
      },
      {
        userId: "seed_user_25",
        displayName: "Kiara Voss",
        category: "Music",
        tier: "Missions",
        baseRate: 125,
        bio: "R&B vocalist and songwriter. Studio sessions, live performances, and hook features. Smooth vibes only.",
        profileSlug: "kiara-voss",
        verified: true,
        plan: "free",
        instagram: "@kiaravossmusic",
        media: ["https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800"],
      },
      {
        userId: "seed_user_26",
        displayName: "Ty Blaze",
        category: "Dance",
        tier: "Tasks",
        baseRate: 80,
        bio: "B-boy and freestyle dancer. Battle champion. Available for events, music videos, and workshops.",
        profileSlug: "ty-blaze",
        verified: false,
        plan: "free",
        instagram: "@tyblaze_",
        media: ["https://images.unsplash.com/photo-1508700929628-666bc8bd84ea?w=800"],
      },
      {
        userId: "seed_user_27",
        displayName: "Ava Sinclair",
        category: "Modeling",
        tier: "Missions",
        baseRate: 180,
        bio: "Commercial and lifestyle model. Diverse portfolio spanning fitness, beauty, and streetwear campaigns.",
        profileSlug: "ava-sinclair",
        verified: true,
        plan: "pro",
        instagram: "@avasinclair",
        tiktok: "@ava.sinclair",
        media: ["https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=800"],
      },
      {
        userId: "seed_user_28",
        displayName: "Jalen Cross",
        category: "Comedy",
        tier: "Tasks",
        baseRate: 75,
        bio: "Up-and-coming comic. High energy crowd work and observational humor. Book me for your next event.",
        profileSlug: "jalen-cross",
        verified: false,
        plan: "free",
        media: ["https://images.unsplash.com/photo-1527224857830-43a7acc85260?w=800"],
      },
      {
        userId: "seed_user_29",
        displayName: "Raven Diaz",
        category: "Music",
        tier: "Projects",
        baseRate: 300,
        bio: "Rapper and lyricist from the south side. 2 mixtapes out, 500K+ streams. Available for features, shows, and festivals.",
        profileSlug: "raven-diaz",
        verified: true,
        plan: "elite",
        instagram: "@ravendiazrap",
        tiktok: "@ravendiaz",
        youtube: "@RavenDiazOfficial",
        media: ["https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800"],
      },
      {
        userId: "seed_user_30",
        displayName: "Mia Torres",
        category: "Dance",
        tier: "Missions",
        baseRate: 100,
        bio: "Latin dance specialist - salsa, bachata, and reggaeton. Teaching and performing for 4 years.",
        profileSlug: "mia-torres",
        verified: true,
        plan: "free",
        instagram: "@miatorres.dance",
        media: ["https://images.unsplash.com/photo-1518834107812-67b0b7c58434?w=800"],
      },
      {
        userId: "seed_user_31",
        displayName: "Devon Hart",
        category: "Acting",
        tier: "Tasks",
        baseRate: 90,
        bio: "Voiceover artist and actor. Commercials, podcasts, and indie projects. Professional home studio setup.",
        profileSlug: "devon-hart",
        verified: true,
        plan: "pro",
        media: ["https://images.unsplash.com/photo-1485846234645-a62644f84728?w=800"],
      },
      {
        userId: "seed_user_50",
        displayName: "Ray Stockton",
        category: "Warehouse & Logistics",
        tier: "Projects",
        baseRate: 18,
        bio: "Certified forklift and pallet jack operator. 4 years warehouse experience. OSHA trained. Available day or night shifts.",
        profileSlug: "ray-stockton",
        verified: true,
        plan: "pro",
      },
      {
        userId: "seed_user_51",
        displayName: "Tasha Williams",
        category: "Warehouse & Logistics",
        tier: "Missions",
        baseRate: 15,
        bio: "Experienced warehouse associate. Picking, packing, inventory counts, and loading docks. Reliable and punctual.",
        profileSlug: "tasha-williams",
        verified: true,
        plan: "free",
      },
      {
        userId: "seed_user_52",
        displayName: "Maria Gonzalez",
        category: "Cleaning & Janitorial",
        tier: "Missions",
        baseRate: 20,
        bio: "Professional cleaner with my own supplies. Residential and commercial deep cleaning. 6 years experience. References available.",
        profileSlug: "maria-gonzalez",
        verified: true,
        plan: "pro",
      },
      {
        userId: "seed_user_53",
        displayName: "Andre Jackson",
        category: "Cleaning & Janitorial",
        tier: "Tasks",
        baseRate: 15,
        bio: "Event cleanup and post-construction cleaning specialist. Bring my own equipment. Fast and thorough.",
        profileSlug: "andre-jackson",
        verified: false,
        plan: "free",
      },
      {
        userId: "seed_user_54",
        displayName: "Kayla Brooks",
        category: "Sales & Retail",
        tier: "Missions",
        baseRate: 14,
        bio: "3 years retail experience in fashion and sneakers. Great with customers, POS systems, and inventory. Available weekends.",
        profileSlug: "kayla-brooks",
        verified: true,
        plan: "free",
      },
      {
        userId: "seed_user_55",
        displayName: "DeMarcus King",
        category: "Sales & Retail",
        tier: "Tasks",
        baseRate: 13,
        bio: "Sales associate with experience in electronics and streetwear. High energy, customer-focused. Can start same day.",
        profileSlug: "demarcus-king",
        verified: true,
        plan: "pro",
      },
      {
        userId: "seed_user_56",
        displayName: "Chris Navarro",
        category: "Studio & Engineering",
        tier: "Projects",
        baseRate: 50,
        bio: "Audio engineer with Pro Tools & Logic Pro certification. 5 years mixing hip-hop, R&B, and drill. Home studio and mobile setup.",
        profileSlug: "chris-navarro",
        verified: true,
        plan: "elite",
        instagram: "@chrisnavarro.eng",
      },
      {
        userId: "seed_user_57",
        displayName: "Jasmine Powell",
        category: "Studio & Engineering",
        tier: "Missions",
        baseRate: 35,
        bio: "Recording and mixing engineer. Specializing in vocals and podcast production. Professional grade equipment.",
        profileSlug: "jasmine-powell",
        verified: true,
        plan: "pro",
      },
      {
        userId: "seed_user_58",
        displayName: "Marcus Reed",
        category: "General Labor",
        tier: "Tasks",
        baseRate: 15,
        bio: "Reliable general laborer. Moving, loading, event setup, demolition cleanup. Strong back, hard worker. Available on short notice.",
        profileSlug: "marcus-reed",
        verified: true,
        plan: "free",
      },
      {
        userId: "seed_user_59",
        displayName: "Tony Flores",
        category: "General Labor",
        tier: "Missions",
        baseRate: 18,
        bio: "Jack of all trades. Furniture assembly, yard work, moving help, and event setup. Own truck for hauling. 7 years experience.",
        profileSlug: "tony-flores",
        verified: true,
        plan: "pro",
      },
      {
        userId: "seed_user_60",
        displayName: "James Patterson",
        category: "Skilled Trades",
        tier: "Projects",
        baseRate: 35,
        bio: "Licensed handyman. Drywall, painting, basic plumbing and electrical. 10+ years in residential and commercial work.",
        profileSlug: "james-patterson",
        verified: true,
        plan: "elite",
      },
      {
        userId: "seed_user_61",
        displayName: "Luis Herrera",
        category: "Skilled Trades",
        tier: "Missions",
        baseRate: 25,
        bio: "Electrician assistant and general contractor helper. OSHA certified. Experienced with commercial and residential projects.",
        profileSlug: "luis-herrera",
        verified: true,
        plan: "pro",
      },
    ];

    for (const p of sampleProfiles) {
      await storage.createProfile(p);
    }
  }
}
