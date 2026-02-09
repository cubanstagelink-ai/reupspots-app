import {
  posts, profiles, bookings, credits, creditLogs,
  verificationRequests, messages, tosAcceptances, applications, professionalVerifications, reviews,
  follows, notifications, userDocuments,
  type Post, type InsertPost, type Profile, type InsertProfile, type UpdateProfileRequest,
  type Booking, type InsertBooking, type Credit, type CreditLog,
  type VerificationRequest, type Message, type TosAcceptance, type InsertMessage, type InsertVerification,
  type Application, type InsertApplication,
  type ProfessionalVerification, type InsertProfessionalVerification,
  type Review, type InsertReview,
  type Follow, type InsertFollow, type Notification, type InsertNotification,
  type UserDocument, type InsertUserDocument
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, ilike, or, and, sql, asc } from "drizzle-orm";

export interface IStorage {
  getPosts(filters?: { search?: string; category?: string; sortBy?: "Newest" | "Pay"; includeNsfw?: boolean; postType?: string }): Promise<Post[]>;
  createPost(post: InsertPost): Promise<Post>;
  getPost(id: number): Promise<Post | undefined>;

  getProfiles(filters?: { category?: string; allowedCategories?: string[]; includeNsfw?: boolean; viewerPostCategories?: string[]; viewerUserId?: string }): Promise<Profile[]>;
  getProfileBySlug(slug: string): Promise<Profile | undefined>;
  getProfileByUserId(userId: string): Promise<Profile | undefined>;
  createProfile(profile: InsertProfile): Promise<Profile>;
  updateProfile(userId: string, updates: UpdateProfileRequest): Promise<Profile | undefined>;

  createBooking(booking: InsertBooking): Promise<Booking>;
  getBooking(id: number): Promise<Booking | undefined>;
  getBookingsByBuyer(buyerUid: string): Promise<Booking[]>;
  getBookingsByWorker(workerSlug: string): Promise<Booking[]>;
  getAllBookings(): Promise<Booking[]>;
  updateBookingStatus(id: number, status: string): Promise<Booking | undefined>;
  updateBookingStripeInfo(id: number, data: { stripeSessionId?: string; stripePaymentIntentId?: string; paymentMethod?: string; status?: string }): Promise<Booking | undefined>;
  updateBookingInstallment(id: number, installment: "deposit" | "final", status: string, stripeSessionId?: string): Promise<Booking | undefined>;
  updateBookingEscrow(id: number, escrowStatus: string): Promise<Booking | undefined>;

  getCredits(userId: string): Promise<Credit | undefined>;
  initCredits(userId: string, balance: number): Promise<Credit>;
  deductCredits(userId: string, amount: number, action: string, description: string): Promise<Credit | undefined>;
  addCredits(userId: string, amount: number, action: string, description: string): Promise<Credit | undefined>;
  getCreditLogs(userId: string): Promise<CreditLog[]>;

  // Verification
  createVerificationRequest(data: InsertVerification): Promise<VerificationRequest>;
  getVerificationsByUser(userId: string): Promise<VerificationRequest[]>;
  getAllVerificationRequests(): Promise<VerificationRequest[]>;
  updateVerificationStatus(id: number, status: string, adminNotes?: string): Promise<VerificationRequest | undefined>;

  // Professional Verification
  createProfessionalVerification(data: InsertProfessionalVerification): Promise<ProfessionalVerification>;
  getProfessionalVerificationsByUser(userId: string): Promise<ProfessionalVerification[]>;
  getProfessionalVerificationByUserAndCategory(userId: string, category: string): Promise<ProfessionalVerification | undefined>;
  getAllProfessionalVerifications(): Promise<ProfessionalVerification[]>;
  updateProfessionalVerificationStatus(id: number, status: string, adminNotes?: string): Promise<ProfessionalVerification | undefined>;

  // Messages
  sendMessage(data: InsertMessage): Promise<Message>;
  getConversation(userId1: string, userId2: string): Promise<Message[]>;
  getConversationList(userId: string): Promise<{partnerId: string; lastMessage: string; lastAt: Date; unreadCount: number}[]>;
  markMessagesRead(fromUserId: string, toUserId: string): Promise<void>;

  // Applications
  createApplication(data: InsertApplication): Promise<Application>;
  getApplicationsByPost(postId: number): Promise<Application[]>;
  getApplicationsByApplicant(applicantId: string): Promise<Application[]>;
  getApplication(id: number): Promise<Application | undefined>;
  getApplicationByPostAndApplicant(postId: number, applicantId: string): Promise<Application | undefined>;
  updateApplicationStatus(id: number, status: string, posterResponse?: string): Promise<Application | undefined>;

  // Reviews
  createReview(data: InsertReview): Promise<Review>;
  getReviewsByProfile(targetProfileId: number, targetType: string): Promise<Review[]>;
  getReviewSummary(targetProfileId: number, targetType: string): Promise<{ likes: number; dislikes: number; total: number }>;
  getReviewByReviewerAndTarget(reviewerUserId: string, targetProfileId: number, targetType: string): Promise<Review | undefined>;
  getPostsByUserId(userId: string): Promise<Post[]>;

  // Follows
  createFollow(data: InsertFollow): Promise<Follow>;
  deleteFollow(followerUserId: string, followedUserId: string): Promise<void>;
  getFollowsByFollower(followerUserId: string): Promise<Follow[]>;
  getFollowersByUser(followedUserId: string): Promise<Follow[]>;
  isFollowing(followerUserId: string, followedUserId: string): Promise<boolean>;
  getFollowerCount(followedUserId: string): Promise<number>;

  // Notifications
  createNotification(data: InsertNotification): Promise<Notification>;
  getNotificationsByUser(userId: string): Promise<Notification[]>;
  getUnreadNotificationCount(userId: string): Promise<number>;
  markNotificationRead(id: number): Promise<void>;
  markAllNotificationsRead(userId: string): Promise<void>;

  // User Documents (Private Vault)
  createDocument(data: InsertUserDocument): Promise<UserDocument>;
  getDocumentsByUser(userId: string): Promise<UserDocument[]>;
  getDocument(id: number): Promise<UserDocument | undefined>;
  deleteDocument(id: number): Promise<void>;
  getDocumentByShareToken(token: string): Promise<UserDocument | undefined>;
  createShareLink(id: number, token: string, expiresAt: Date): Promise<UserDocument | undefined>;

  // TOS
  acceptTos(userId: string): Promise<TosAcceptance>;
  getTosAcceptance(userId: string): Promise<TosAcceptance | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getPosts(filters?: { search?: string; category?: string; sortBy?: "Newest" | "Pay"; includeNsfw?: boolean; postType?: string }): Promise<Post[]> {
    let query = db.select().from(posts);
    const conditions = [];

    if (!filters?.includeNsfw) {
      conditions.push(eq(posts.nsfw, false));
    }

    if (filters?.postType && filters.postType !== "all") {
      conditions.push(eq(posts.postType, filters.postType));
    }

    if (filters?.category && filters.category !== "All") {
      conditions.push(eq(posts.category, filters.category));
    }

    if (filters?.search) {
      const searchLower = `%${filters.search.toLowerCase()}%`;
      conditions.push(or(
        ilike(posts.title, searchLower),
        ilike(posts.venue, searchLower),
        ilike(posts.promoterName, searchLower),
        ilike(posts.address, searchLower)
      ));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    if (filters?.sortBy === "Pay") {
      query = query.orderBy(desc(posts.pay));
    } else {
      query = query.orderBy(
        sql`CASE WHEN ${posts.boostExpiresAt} > NOW() THEN 0 ELSE 1 END ASC`,
        desc(sql`CASE WHEN ${posts.boostExpiresAt} > NOW() THEN ${posts.boostExpiresAt} ELSE NULL END`),
        sql`CASE WHEN ${posts.verified} = true THEN 0 ELSE 1 END ASC`,
        sql`CASE
          WHEN ${posts.tier} = 'Chances' THEN 1
          WHEN ${posts.tier} = 'Projects' THEN 2
          WHEN ${posts.tier} = 'Tasks' THEN 3
          WHEN ${posts.tier} = 'Missions' THEN 4
          WHEN ${posts.tier} = 'Slots' THEN 5
          ELSE 6
        END ASC`,
        desc(posts.createdAt)
      );
    }

    return await query;
  }

  async createPost(post: InsertPost): Promise<Post> {
    const [newPost] = await db.insert(posts).values(post).returning();
    return newPost;
  }

  async getPost(id: number): Promise<Post | undefined> {
    const [post] = await db.select().from(posts).where(eq(posts.id, id));
    return post;
  }

  async getProfiles(filters?: { category?: string; allowedCategories?: string[]; includeNsfw?: boolean; viewerPostCategories?: string[]; viewerUserId?: string }): Promise<Profile[]> {
    const conditions = [];

    if (!filters?.includeNsfw) {
      conditions.push(sql`${profiles.category} != 'Adult/NSFW'`);
    }

    if (filters?.allowedCategories && filters.allowedCategories.length > 0) {
      const categoryOrs = [
        sql`${profiles.category} IN (${sql.join(filters.allowedCategories.map(c => sql`${c}`), sql`, `)})`,
      ];
      if (filters?.viewerUserId) {
        categoryOrs.push(eq(profiles.userId, filters.viewerUserId));
      }
      conditions.push(or(...categoryOrs)!);
    } else if (filters?.category) {
      conditions.push(eq(profiles.category, filters.category));
    }

    const visibilityOrs = [
      eq(profiles.visibility, "public"),
      sql`${profiles.visibility} IS NULL`,
    ];

    if (filters?.viewerUserId) {
      visibilityOrs.push(eq(profiles.userId, filters.viewerUserId));
    }

    if (filters?.viewerPostCategories && filters.viewerPostCategories.length > 0) {
      visibilityOrs.push(
        sql`${profiles.category} IN (${sql.join(filters.viewerPostCategories.map(c => sql`${c}`), sql`, `)})`
      );
    }

    conditions.push(or(...visibilityOrs)!);

    if (conditions.length > 0) {
      return await db.select().from(profiles).where(and(...conditions));
    }
    return await db.select().from(profiles);
  }

  async getProfileBySlug(slug: string): Promise<Profile | undefined> {
    const [profile] = await db.select().from(profiles).where(eq(profiles.profileSlug, slug));
    return profile;
  }

  async getProfileByUserId(userId: string): Promise<Profile | undefined> {
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId));
    return profile;
  }

  async createProfile(profile: InsertProfile): Promise<Profile> {
    const [newProfile] = await db.insert(profiles).values(profile).returning();
    return newProfile;
  }

  async updateProfile(userId: string, updates: UpdateProfileRequest): Promise<Profile | undefined> {
    const [updated] = await db.update(profiles)
      .set(updates)
      .where(eq(profiles.userId, userId))
      .returning();
    return updated;
  }

  async createBooking(booking: InsertBooking): Promise<Booking> {
    const [newBooking] = await db.insert(bookings).values(booking).returning();
    return newBooking;
  }

  async getBooking(id: number): Promise<Booking | undefined> {
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));
    return booking;
  }

  async getBookingsByBuyer(buyerUid: string): Promise<Booking[]> {
    return await db.select().from(bookings).where(eq(bookings.buyerUid, buyerUid)).orderBy(desc(bookings.createdAt));
  }

  async getBookingsByWorker(workerSlug: string): Promise<Booking[]> {
    return await db.select().from(bookings).where(eq(bookings.workerSlug, workerSlug)).orderBy(desc(bookings.createdAt));
  }

  async getAllBookings(): Promise<Booking[]> {
    return await db.select().from(bookings).orderBy(desc(bookings.createdAt));
  }

  async updateBookingStatus(id: number, status: string): Promise<Booking | undefined> {
    const [updated] = await db.update(bookings)
      .set({ status })
      .where(eq(bookings.id, id))
      .returning();
    return updated;
  }

  async updateBookingStripeInfo(id: number, data: { stripeSessionId?: string; stripePaymentIntentId?: string; paymentMethod?: string; status?: string }): Promise<Booking | undefined> {
    const [updated] = await db.update(bookings)
      .set(data)
      .where(eq(bookings.id, id))
      .returning();
    return updated;
  }

  async updateBookingInstallment(id: number, installment: "deposit" | "final", status: string, stripeSessionId?: string): Promise<Booking | undefined> {
    const setData: any = {};
    if (installment === "deposit") {
      setData.depositStatus = status;
      if (stripeSessionId) setData.depositStripeSessionId = stripeSessionId;
    } else {
      setData.finalStatus = status;
      if (stripeSessionId) setData.finalStripeSessionId = stripeSessionId;
    }

    const [updated] = await db.update(bookings)
      .set(setData)
      .where(eq(bookings.id, id))
      .returning();

    if (updated && updated.paymentStructure === "split_50_50") {
      if (updated.depositStatus === "paid" && updated.finalStatus === "paid") {
        return this.updateBookingStatus(id, "confirmed");
      } else if (updated.depositStatus === "paid" && updated.finalStatus === "pending") {
        return this.updateBookingStatus(id, "deposit_paid");
      } else if (updated.depositStatus === "submitted" || updated.finalStatus === "submitted") {
        return this.updateBookingStatus(id, "payment_submitted");
      }
    }
    return updated;
  }

  async updateBookingEscrow(id: number, escrowStatus: string): Promise<Booking | undefined> {
    const setData: any = { escrowStatus };
    if (escrowStatus === "authorized") {
      setData.escrowAuthorizedAt = new Date();
    } else if (escrowStatus === "captured") {
      setData.escrowCapturedAt = new Date();
    }
    const [updated] = await db.update(bookings)
      .set(setData)
      .where(eq(bookings.id, id))
      .returning();
    return updated;
  }

  async getCredits(userId: string): Promise<Credit | undefined> {
    const [credit] = await db.select().from(credits).where(eq(credits.userId, userId));
    return credit;
  }

  async initCredits(userId: string, balance: number): Promise<Credit> {
    const existing = await this.getCredits(userId);
    if (existing) return existing;
    const [credit] = await db.insert(credits).values({ userId, balance }).returning();
    await db.insert(creditLogs).values({
      userId,
      action: "init",
      amount: balance,
      description: "Initial credit allocation",
    });
    return credit;
  }

  async deductCredits(userId: string, amount: number, action: string, description: string): Promise<Credit | undefined> {
    const current = await this.getCredits(userId);
    if (!current || current.balance < amount) return undefined;

    const [updated] = await db.update(credits)
      .set({ balance: current.balance - amount, updatedAt: new Date() })
      .where(eq(credits.userId, userId))
      .returning();

    await db.insert(creditLogs).values({
      userId,
      action,
      amount: -amount,
      description,
    });

    return updated;
  }

  async addCredits(userId: string, amount: number, action: string, description: string): Promise<Credit | undefined> {
    const current = await this.getCredits(userId);
    if (!current) {
      return await this.initCredits(userId, amount);
    }

    const [updated] = await db.update(credits)
      .set({ balance: current.balance + amount, updatedAt: new Date() })
      .where(eq(credits.userId, userId))
      .returning();

    await db.insert(creditLogs).values({
      userId,
      action,
      amount,
      description,
    });

    return updated;
  }

  async getCreditLogs(userId: string): Promise<CreditLog[]> {
    return await db.select().from(creditLogs).where(eq(creditLogs.userId, userId)).orderBy(desc(creditLogs.createdAt));
  }

  async createVerificationRequest(data: InsertVerification): Promise<VerificationRequest> {
    const [record] = await db.insert(verificationRequests).values(data).returning();
    return record;
  }

  async getVerificationsByUser(userId: string): Promise<VerificationRequest[]> {
    return await db.select().from(verificationRequests).where(eq(verificationRequests.userId, userId)).orderBy(desc(verificationRequests.createdAt));
  }

  async getAllVerificationRequests(): Promise<VerificationRequest[]> {
    return await db.select().from(verificationRequests).orderBy(desc(verificationRequests.createdAt));
  }

  async updateVerificationStatus(id: number, status: string, adminNotes?: string): Promise<VerificationRequest | undefined> {
    const [updated] = await db.update(verificationRequests)
      .set({ status, adminNotes, reviewedAt: new Date() })
      .where(eq(verificationRequests.id, id))
      .returning();
    return updated;
  }

  async createProfessionalVerification(data: InsertProfessionalVerification): Promise<ProfessionalVerification> {
    const [record] = await db.insert(professionalVerifications).values(data).returning();
    return record;
  }

  async getProfessionalVerificationsByUser(userId: string): Promise<ProfessionalVerification[]> {
    return await db.select().from(professionalVerifications).where(eq(professionalVerifications.userId, userId)).orderBy(desc(professionalVerifications.createdAt));
  }

  async getProfessionalVerificationByUserAndCategory(userId: string, category: string): Promise<ProfessionalVerification | undefined> {
    const [record] = await db.select().from(professionalVerifications)
      .where(and(
        eq(professionalVerifications.userId, userId),
        eq(professionalVerifications.category, category),
        eq(professionalVerifications.status, "approved")
      ))
      .orderBy(desc(professionalVerifications.createdAt))
      .limit(1);
    return record;
  }

  async getAllProfessionalVerifications(): Promise<ProfessionalVerification[]> {
    return await db.select().from(professionalVerifications).orderBy(desc(professionalVerifications.createdAt));
  }

  async updateProfessionalVerificationStatus(id: number, status: string, adminNotes?: string): Promise<ProfessionalVerification | undefined> {
    const [updated] = await db.update(professionalVerifications)
      .set({ status, adminNotes, reviewedAt: new Date() })
      .where(eq(professionalVerifications.id, id))
      .returning();
    return updated;
  }

  async sendMessage(data: InsertMessage): Promise<Message> {
    const [record] = await db.insert(messages).values(data).returning();
    return record;
  }

  async getConversation(userId1: string, userId2: string): Promise<Message[]> {
    return await db.select().from(messages)
      .where(
        or(
          and(eq(messages.fromUserId, userId1), eq(messages.toUserId, userId2)),
          and(eq(messages.fromUserId, userId2), eq(messages.toUserId, userId1))
        )
      )
      .orderBy(asc(messages.createdAt));
  }

  async getConversationList(userId: string): Promise<{partnerId: string; lastMessage: string; lastAt: Date; unreadCount: number}[]> {
    const result = await db.execute(sql`
      SELECT
        partner_id as "partnerId",
        last_message as "lastMessage",
        last_at as "lastAt",
        unread_count as "unreadCount"
      FROM (
        SELECT
          CASE WHEN from_user_id = ${userId} THEN to_user_id ELSE from_user_id END as partner_id,
          (array_agg(content ORDER BY created_at DESC))[1] as last_message,
          MAX(created_at) as last_at,
          COUNT(*) FILTER (WHERE to_user_id = ${userId} AND read = false) as unread_count
        FROM messages
        WHERE from_user_id = ${userId} OR to_user_id = ${userId}
        GROUP BY partner_id
      ) sub
      ORDER BY last_at DESC
    `);
    return result.rows as any;
  }

  async markMessagesRead(fromUserId: string, toUserId: string): Promise<void> {
    await db.update(messages)
      .set({ read: true })
      .where(and(eq(messages.fromUserId, fromUserId), eq(messages.toUserId, toUserId)));
  }

  async createApplication(data: InsertApplication): Promise<Application> {
    const [record] = await db.insert(applications).values(data).returning();
    return record;
  }

  async getApplicationsByPost(postId: number): Promise<Application[]> {
    return await db.select().from(applications).where(eq(applications.postId, postId)).orderBy(desc(applications.createdAt));
  }

  async getApplicationsByApplicant(applicantId: string): Promise<Application[]> {
    return await db.select().from(applications).where(eq(applications.applicantId, applicantId)).orderBy(desc(applications.createdAt));
  }

  async getApplication(id: number): Promise<Application | undefined> {
    const [record] = await db.select().from(applications).where(eq(applications.id, id));
    return record;
  }

  async getApplicationByPostAndApplicant(postId: number, applicantId: string): Promise<Application | undefined> {
    const [record] = await db.select().from(applications)
      .where(and(eq(applications.postId, postId), eq(applications.applicantId, applicantId)));
    return record;
  }

  async updateApplicationStatus(id: number, status: string, posterResponse?: string): Promise<Application | undefined> {
    const [updated] = await db.update(applications)
      .set({ status, posterResponse, respondedAt: new Date() })
      .where(eq(applications.id, id))
      .returning();
    return updated;
  }

  async createReview(data: InsertReview): Promise<Review> {
    const [record] = await db.insert(reviews).values(data).returning();
    return record;
  }

  async getReviewsByProfile(targetProfileId: number, targetType: string): Promise<Review[]> {
    return await db.select().from(reviews)
      .where(and(eq(reviews.targetProfileId, targetProfileId), eq(reviews.targetType, targetType)))
      .orderBy(desc(reviews.createdAt));
  }

  async getReviewSummary(targetProfileId: number, targetType: string): Promise<{ likes: number; dislikes: number; total: number }> {
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE rating = 1) as likes,
        COUNT(*) FILTER (WHERE rating = -1) as dislikes,
        COUNT(*) as total
      FROM reviews
      WHERE target_profile_id = ${targetProfileId} AND target_type = ${targetType}
    `);
    const row = result.rows[0] as any;
    return { likes: Number(row?.likes || 0), dislikes: Number(row?.dislikes || 0), total: Number(row?.total || 0) };
  }

  async getReviewByReviewerAndTarget(reviewerUserId: string, targetProfileId: number, targetType: string): Promise<Review | undefined> {
    const [record] = await db.select().from(reviews)
      .where(and(
        eq(reviews.reviewerUserId, reviewerUserId),
        eq(reviews.targetProfileId, targetProfileId),
        eq(reviews.targetType, targetType)
      ));
    return record;
  }

  async getPostsByUserId(userId: string): Promise<Post[]> {
    return await db.select().from(posts).where(eq(posts.userId, userId)).orderBy(desc(posts.createdAt));
  }

  async acceptTos(userId: string): Promise<TosAcceptance> {
    const [record] = await db.insert(tosAcceptances)
      .values({ userId })
      .onConflictDoUpdate({
        target: tosAcceptances.userId,
        set: { acceptedAt: new Date() },
      })
      .returning();
    return record;
  }

  async getTosAcceptance(userId: string): Promise<TosAcceptance | undefined> {
    const [record] = await db.select().from(tosAcceptances).where(eq(tosAcceptances.userId, userId));
    return record;
  }

  async createFollow(data: InsertFollow): Promise<Follow> {
    const [record] = await db.insert(follows).values(data).returning();
    return record;
  }

  async deleteFollow(followerUserId: string, followedUserId: string): Promise<void> {
    await db.delete(follows).where(
      and(eq(follows.followerUserId, followerUserId), eq(follows.followedUserId, followedUserId))
    );
  }

  async getFollowsByFollower(followerUserId: string): Promise<Follow[]> {
    return await db.select().from(follows).where(eq(follows.followerUserId, followerUserId)).orderBy(desc(follows.createdAt));
  }

  async getFollowersByUser(followedUserId: string): Promise<Follow[]> {
    return await db.select().from(follows).where(eq(follows.followedUserId, followedUserId)).orderBy(desc(follows.createdAt));
  }

  async isFollowing(followerUserId: string, followedUserId: string): Promise<boolean> {
    const [record] = await db.select().from(follows).where(
      and(eq(follows.followerUserId, followerUserId), eq(follows.followedUserId, followedUserId))
    );
    return !!record;
  }

  async getFollowerCount(followedUserId: string): Promise<number> {
    const result = await db.execute(sql`SELECT COUNT(*) as count FROM follows WHERE followed_user_id = ${followedUserId}`);
    return Number((result.rows[0] as any)?.count || 0);
  }

  async createNotification(data: InsertNotification): Promise<Notification> {
    const [record] = await db.insert(notifications).values(data).returning();
    return record;
  }

  async getNotificationsByUser(userId: string): Promise<Notification[]> {
    return await db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(50);
  }

  async getUnreadNotificationCount(userId: string): Promise<number> {
    const result = await db.execute(sql`SELECT COUNT(*) as count FROM notifications WHERE user_id = ${userId} AND read = false`);
    return Number((result.rows[0] as any)?.count || 0);
  }

  async markNotificationRead(id: number): Promise<void> {
    await db.update(notifications).set({ read: true }).where(eq(notifications.id, id));
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    await db.update(notifications).set({ read: true }).where(eq(notifications.userId, userId));
  }

  async createDocument(data: InsertUserDocument): Promise<UserDocument> {
    const [doc] = await db.insert(userDocuments).values(data).returning();
    return doc;
  }

  async getDocumentsByUser(userId: string): Promise<UserDocument[]> {
    return await db.select().from(userDocuments).where(eq(userDocuments.userId, userId)).orderBy(desc(userDocuments.createdAt));
  }

  async getDocument(id: number): Promise<UserDocument | undefined> {
    const [doc] = await db.select().from(userDocuments).where(eq(userDocuments.id, id));
    return doc;
  }

  async deleteDocument(id: number): Promise<void> {
    await db.delete(userDocuments).where(eq(userDocuments.id, id));
  }

  async getDocumentByShareToken(token: string): Promise<UserDocument | undefined> {
    const [doc] = await db.select().from(userDocuments).where(eq(userDocuments.shareToken, token));
    return doc;
  }

  async createShareLink(id: number, token: string, expiresAt: Date): Promise<UserDocument | undefined> {
    const [updated] = await db.update(userDocuments)
      .set({ shareToken: token, shareExpiresAt: expiresAt })
      .where(eq(userDocuments.id, id))
      .returning();
    return updated;
  }
}

export const storage = new DatabaseStorage();
