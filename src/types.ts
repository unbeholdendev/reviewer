import { z } from "zod";

export const Review = z.object({
  summary: z.string(),
  recommendation: z.enum(["blocking", "nits", "looks-good"]),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      side: z.enum(["LEFT", "RIGHT"]),
      body: z.string(),
      severity: z.enum(["blocking", "nit"]),
    }),
  ),
  addressed: z.array(z.object({ commentId: z.number().int(), sha: z.string().regex(/^[0-9a-f]{7,40}$/) })),
});
export type Review = z.infer<typeof Review>;
export type Comment = Review["comments"][number];

export const ForgejoUser = z.object({ login: z.string() });
export const ForgejoReview = z.object({ id: z.number(), user: ForgejoUser.nullable(), body: z.string() });
export const ForgejoReviewComment = z.object({
  id: z.number(),
  user: ForgejoUser.nullable(),
  path: z.string(),
  position: z.number(),
  original_position: z.number(),
  body: z.string(),
  resolver: ForgejoUser.nullable(),
});
export const ForgejoCreated = z.object({ id: z.number() });

export type PR = { owner: string; repo: string; number: number };
export type Checkout = { dir: string; diff: string; log: string; rules: string; incremental?: boolean };
export type InlineComment = { path: string; body: string; new_position?: number; old_position?: number };
export type BotComment = { id: number; review: number; user: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string; resolved: boolean };

export type Forgejo = {
  login: string;
  createReview(pr: PR, review: { event: "COMMENT"; body: string; comments: InlineComment[] }): Promise<void>;
  reviews(pr: PR): Promise<{ id: number; user: string; body: string }[]>;
  comments(pr: PR, review: number): Promise<BotComment[]>;
  reply(pr: PR, comment: BotComment, body: string): Promise<void>;
};
export type Git = {
  checkout(pr: PR, base: string, head: string, since?: string): Promise<Checkout>;
  remove(checkout: Checkout): Promise<void>;
};
export type Claude = { review(checkout: Checkout, large: boolean, open: BotComment[]): Promise<Review> };
export type Adapters = { forgejo: Forgejo; git: Git; claude: Claude };
