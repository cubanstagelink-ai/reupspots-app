import { z } from 'zod';
import { insertPostSchema, insertProfileSchema, insertBookingSchema, posts, profiles, bookings, credits, applications } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

export const api = {
  posts: {
    list: {
      method: 'GET' as const,
      path: '/api/posts' as const,
      input: z.object({
        search: z.string().optional(),
        category: z.string().optional(),
        sortBy: z.enum(["Newest", "Pay"]).optional(),
        includeNsfw: z.boolean().optional(),
        postType: z.enum(["gig", "event", "all"]).optional(),
      }).optional(),
      responses: {
        200: z.array(z.custom<typeof posts.$inferSelect>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/posts' as const,
      input: insertPostSchema,
      responses: {
        201: z.custom<typeof posts.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
  },
  profiles: {
    list: {
      method: 'GET' as const,
      path: '/api/profiles' as const,
      responses: {
        200: z.array(z.custom<typeof profiles.$inferSelect>()),
      },
    },
    getBySlug: {
      method: 'GET' as const,
      path: '/api/profiles/:slug' as const,
      responses: {
        200: z.custom<typeof profiles.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/profiles' as const,
      input: insertProfileSchema,
      responses: {
        201: z.custom<typeof profiles.$inferSelect>(),
        400: errorSchemas.validation,
      },
    }
  },
  me: {
    get: {
      method: 'GET' as const,
      path: '/api/me' as const,
      responses: {
        200: z.object({
          user: z.any(),
          profile: z.custom<typeof profiles.$inferSelect>().nullable(),
          credits: z.custom<typeof credits.$inferSelect>().nullable(),
        }),
        401: errorSchemas.internal,
      }
    }
  },
  bookings: {
    create: {
      method: 'POST' as const,
      path: '/api/bookings' as const,
      input: z.object({
        postId: z.number().optional(),
        workerSlug: z.string().optional(),
        tier: z.string(),
        basePay: z.number(),
        boost: z.string().optional(),
        paymentStructure: z.string().optional(),
      }),
      responses: {
        201: z.custom<typeof bookings.$inferSelect>(),
        400: errorSchemas.validation,
        401: errorSchemas.internal,
      },
    },
    myBookings: {
      method: 'GET' as const,
      path: '/api/bookings/mine' as const,
      responses: {
        200: z.array(z.custom<typeof bookings.$inferSelect>()),
      },
    },
    markPaid: {
      method: 'POST' as const,
      path: '/api/bookings/:id/mark-paid' as const,
      responses: {
        200: z.custom<typeof bookings.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    confirm: {
      method: 'POST' as const,
      path: '/api/bookings/:id/confirm' as const,
      responses: {
        200: z.custom<typeof bookings.$inferSelect>(),
        403: errorSchemas.internal,
        404: errorSchemas.notFound,
      },
    },
    cancel: {
      method: 'POST' as const,
      path: '/api/bookings/:id/cancel' as const,
      responses: {
        200: z.custom<typeof bookings.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    all: {
      method: 'GET' as const,
      path: '/api/admin/bookings' as const,
      responses: {
        200: z.array(z.custom<typeof bookings.$inferSelect>()),
        403: errorSchemas.internal,
      },
    },
  },
  applications: {
    create: {
      method: 'POST' as const,
      path: '/api/applications' as const,
      input: z.object({
        postId: z.number(),
      }),
      responses: {
        201: z.custom<typeof applications.$inferSelect>(),
        400: errorSchemas.validation,
        401: errorSchemas.internal,
      },
    },
    mine: {
      method: 'GET' as const,
      path: '/api/applications/mine' as const,
      responses: {
        200: z.array(z.custom<typeof applications.$inferSelect>()),
      },
    },
    forPost: {
      method: 'GET' as const,
      path: '/api/applications/post/:postId' as const,
      responses: {
        200: z.array(z.custom<typeof applications.$inferSelect>()),
      },
    },
    respond: {
      method: 'POST' as const,
      path: '/api/applications/:id/respond' as const,
      input: z.object({
        status: z.enum(["accepted", "rejected"]),
        posterResponse: z.string().optional(),
      }),
      responses: {
        200: z.custom<typeof applications.$inferSelect>(),
        403: errorSchemas.internal,
        404: errorSchemas.notFound,
      },
    },
  },
  credits: {
    get: {
      method: 'GET' as const,
      path: '/api/credits' as const,
      responses: {
        200: z.custom<typeof credits.$inferSelect>(),
      },
    },
    logs: {
      method: 'GET' as const,
      path: '/api/credits/logs' as const,
      responses: {
        200: z.array(z.any()),
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

export type PostInput = z.infer<typeof api.posts.create.input>;
export type ProfileInput = z.infer<typeof api.profiles.create.input>;
export type BookingInput = z.infer<typeof api.bookings.create.input>;
